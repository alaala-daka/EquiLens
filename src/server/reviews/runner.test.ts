import assert from "node:assert/strict"
import { test } from "node:test"
import type { AgentReviewOptions } from "../../../tools/contract-review/src/agent"
import type { ReviewSkill } from "../../../tools/contract-review/src/agent/skill"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { sceneCatalog, type SceneCandidate } from "../../../tools/contract-review/src/scenes"
import type { SceneBundle } from "../../../tools/contract-review/src/bundles"
import type { LoadedPack, ReviewResult } from "../../../tools/contract-review/src/types"
import { createProjectReviewRunner } from "./runner"
import { successResult, validRunnerInput } from "./test-fixtures"

const candidate = (id: string): SceneCandidate => {
  const found = sceneCatalog().find(item => item.id === id)
  if (!found) throw new Error(`missing scene ${id}`)
  return found
}
const skill = (id: string): ReviewSkill => ({
  id: id as ReviewSkill["id"], name: "测试技能", version: "1", description: "测试", instructions: "测试指令", sha256: "a".repeat(64),
})
const pack = (scene: string): LoadedPack => ({
  manifest: { version: "0.2.0-draft", name: "测试规则包", status: "待核对", ruleFiles: [], sourceFiles: [] },
  rules: [{ ruleId: "PAY-001", category: "付款条件与时间", title: "测试规则", status: "待核对", appliesTo: { scene },
    trigger: { keywords: ["付款"] }, requirement: "测试要求", severity: "重大关注", basis: [{ sourceId: "LEGAL-01" }] }],
  sources: [], warnings: [],
})
const bundle = (id: string): SceneBundle => {
  const scene = candidate(id)
  const value = { candidate: scene, pack: pack(scene.id), skill: skill(scene.skillId) }
  return { ...value, sha256: "b".repeat(64) }
}

test("A4c production runner: auto resolves to the default scene and runs debug-mode reviewWithAgent options", async () => {
  let received: AgentReviewOptions | undefined
  const runner = createProjectReviewRunner({
    loadBundles: async () => [bundle("mep-sub-2026"), bundle("decoration-sub-2026")],
    review: async options => { received = options; return successResult(validRunnerInput()) },
  })
  const beforeCalls: number[] = []
  const exchanges: unknown[] = []
  const result = await runner({
    ...validRunnerInput(), maxCalls: 100,
    onBeforeCall: async reservation => { beforeCalls.push(reservation.callNumber) },
    onExchange: async exchange => { exchanges.push(exchange) },
  })
  assert.equal(result.schemaVersion, 1)
  assert.ok(received)
  assert.equal(received.mode, "debug")
  assert.equal(received.context?.scene, "mep-sub-2026")
  assert.equal(received.context?.role, "专业分包人")
  assert.equal(received.context?.region, "上海")
  assert.equal(received.sceneCandidates, undefined)
  assert.equal(received.maxCalls, 40)
  assert.equal(received.pack?.manifest.status, "待核对")
  assert.equal(received.skill?.id, "contract-review")
  assert.deepEqual(received.paragraphs?.map(paragraph => paragraph.index), [0, 1])
  assert.ok(received.paragraphs?.every(paragraph => paragraph.inTable === false))
  await received.onBeforeCall?.({ callNumber: 3, ruleIds: [] })
  assert.deepEqual(beforeCalls, [3])
  await received.onModelExchange?.({ callNumber: 3, request: {}, response: {}, agentRole: "primary" })
  assert.equal(exchanges.length, 1)
})

test("A4c production runner: an explicit registered scene selects that scene bundle", async () => {
  let received: AgentReviewOptions | undefined
  const runner = createProjectReviewRunner({
    loadBundles: async () => [bundle("mep-sub-2026"), bundle("decoration-sub-2026")],
    review: async options => { received = options; return successResult(validRunnerInput()) },
  })
  await runner({ ...validRunnerInput(), context: { ...validRunnerInput().context, scene: "decoration-sub-2026" } })
  assert.ok(received)
  assert.equal(received.context?.scene, "decoration-sub-2026")
  assert.equal(received.context?.projectType, "房建装饰装修专业分包")
  assert.equal(received.skill?.id, "decoration-review")
})

test("A4c production runner: unknown scenes and rule-pack outages stay controlled failures", async () => {
  const runner = createProjectReviewRunner({
    loadBundles: async () => [bundle("mep-sub-2026")],
    review: async () => successResult(validRunnerInput()),
  })
  await assert.rejects(runner({ ...validRunnerInput(), context: { ...validRunnerInput().context, scene: "unsupported-scene" } }),
    (failure: unknown) => failure instanceof ReviewError && failure.code === "REVIEW_SCENE_INVALID")
  const unavailable = createProjectReviewRunner({
    loadBundles: async () => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") },
    review: async () => successResult(validRunnerInput()),
  })
  await assert.rejects(unavailable(validRunnerInput()),
    (failure: unknown) => failure instanceof ReviewError && failure.code === "REVIEW_RULE_PACK_INVALID")
})

test("A4c production runner: the runner returns exactly the reviewWithAgent result", async () => {
  const expected: ReviewResult = { ...successResult(validRunnerInput()), reviewId: "specific-result" }
  const runner = createProjectReviewRunner({
    loadBundles: async () => [bundle("mep-sub-2026")],
    review: async () => expected,
  })
  assert.deepEqual(await runner(validRunnerInput()), expected)
})
