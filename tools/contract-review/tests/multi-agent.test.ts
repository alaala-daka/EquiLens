import assert from "node:assert/strict"
import { before, test } from "node:test"
import { loadSceneBundles, validateBundles, type SceneBundle } from "../src/bundles"
import { reviewWithAgents } from "../src/agent/pipeline"
import { publishedRules } from "../src/pack"
import { isCompleteNoRisk } from "../src/presentation"
import type { SceneId } from "../src/scenes"
import type { ReviewResult } from "../src/types"

let bundles: SceneBundle[] = []
before(async () => { bundles = await loadSceneBundles() })
const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
const text = "合成办公楼专业分包合同：机电安装、装饰、幕墙或钢结构的测试材料，具体场景由测试指定，不用于法律质量验证。"
function transport(id: SceneId, refuseAudit = 0) {
  const bundle = bundles.find(item => item.candidate.id === id)!
  let primaryStep = 0, auditCalls = 0, refused = false
  const roles: string[] = [], primaryRules: string[][] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), menu = body.tools.map((item: { function: { name: string } }) => item.function.name)
    let name: string, input: unknown
    if (menu.length === 1 && menu[0] === "selectScene") {
      roles.push("router"); name = "selectScene"
      input = { status: "matched", sceneId: id, reason: "合成测试指定场景。", evidence: [{ paragraphIndex: 0, quote: text }], missingInfo: [] }
    } else if (menu.length === 1 && menu[0] === "submitAudit") {
      roles.push("auditor"); auditCalls++
      if (auditCalls === refuseAudit && !refused) { refused = true; return Response.json({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }) }
      const batch = JSON.parse(body.messages.at(-1).content).targetRuleIds as string[]
      name = "submitAudit"; input = { checks: batch.map(ruleId => ({ ruleId, outcome: "保留", issueTypes: [], note: "合成核对，仍待人工复核。",
        paragraphIndex: 0, quote: text, basis: [bundle.pack.rules.find(rule => rule.ruleId === ruleId)!.basis[0].sourceId] })) }
    } else {
      roles.push("primary")
      primaryStep++
      if (primaryStep === 1) { name = "loadSkill"; input = { skillId: bundle.skill.id } }
      else if (primaryStep === 2) { name = "readParagraphs"; input = { indexes: [0] } }
      else if (primaryStep === 3) { name = "readSources"; input = { sourceIds: [...new Set(bundle.pack.rules.flatMap(rule => rule.basis.map(item => item.sourceId)))] } }
      else {
        const batch = bundle.pack.rules.slice((primaryStep - 4) * 3, (primaryStep - 3) * 3)
        primaryRules.push(batch.map(item => item.ruleId))
        name = "submitFindings"; input = { findings: batch.map(rule => ({ ruleId: rule.ruleId, kind: "发现问题", risk: "合成检查发现测试问题。", severity: rule.severity,
          quote: text, paragraphIndex: 0, basis: [rule.basis[0].sourceId], impact: "", suggestion: "核对测试字段。", pending: [] })) }
      }
    }
    return Response.json({ id: `multi-${roles.length}`, object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: `call-${roles.length}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  return { fetcher, roles, primaryRules }
}
const options = { get bundles() { return bundles }, documentText: text, context: { role: "专业分包人", region: "上海" }, mode: "debug" as const, env, maxPromptChars: 240000 }

test("AC-21/24: four scenes bind distinct skills and scoped rules without inheriting publication", () => {
  assert.equal(bundles.length, 4)
  assert.equal(new Set(bundles.map(item => item.skill.id)).size, 4)
  for (const bundle of bundles) {
    assert.equal(bundle.pack.rules.length, bundle.candidate.id === "mep-sub-2026" ? 19 : 22)
    assert.ok(bundle.pack.rules.every(rule => rule.appliesTo.scene === bundle.candidate.id))
    assert.equal(publishedRules(bundle.pack).length, 0)
  }
  const changed = structuredClone(bundles)
  changed[1].pack.rules[0].requirement = "changed"
  assert.throws(() => validateBundles(changed))
})

test("AC-24: a direct multi-agent entry cannot route draft bundles in published mode", async () => {
  const state = transport("mep-sub-2026")
  await assert.rejects(reviewWithAgents({ ...options, mode: "published", fetcher: state.fetcher }), { code: "REVIEW_RULES_UNAVAILABLE" })
  assert.equal(state.roles.length, 0)
})

test("AC-23: invalid direct-entry limits fail before any role sends a request", async () => {
  const state = transport("mep-sub-2026")
  for (const limits of [{ maxPromptChars: Number.NaN }, { requestTimeoutMs: 90001 }, { maxToolChars: 64001 }]) {
    await assert.rejects(reviewWithAgents({ ...options, ...limits, fetcher: state.fetcher }), { code: "REVIEW_INPUT_INVALID" })
  }
  assert.equal(state.roles.length, 0)
})

test("AC-03/21/23: each scene runs isolated routing, correct primary skill/rules and complete audit", async () => {
  for (const bundle of bundles) {
    const state = transport(bundle.candidate.id)
    const reservations: number[] = [], exchangeRoles: string[] = []
    const result = await reviewWithAgents({ ...options, fetcher: state.fetcher,
      onBeforeCall: async value => { reservations.push(value.callNumber) },
      onModelExchange: async value => { exchangeRoles.push(value.agentRole!) } })
    assert.equal(result.status, "success")
    assert.equal(result.sceneSelection?.sceneId, bundle.candidate.id)
    assert.equal(result.collaboration?.primary?.agent?.skill.id, bundle.skill.id)
    assert.equal(result.collaboration?.audit?.checks.length, bundle.pack.rules.length)
    assert.equal(result.findings.length, bundle.pack.rules.length)
    assert.deepEqual(state.primaryRules.flat(), bundle.pack.rules.map(item => item.ruleId))
    assert.deepEqual(exchangeRoles, state.roles)
    assert.deepEqual(reservations, Array.from({ length: state.roles.length }, (_, index) => index + 1))
    assert.ok(result.callsUsed <= 25)
    assert.ok(!state.roles.slice(state.roles.indexOf("auditor")).includes("primary"))
    assert.equal(result.usage?.totalTokens, state.roles.length * 15)
    assert.ok(result.collaboration!.audit!.checks.every(item => item.outcome === "保留"))
    assert.ok(result.findings.every(item => item.reviewStatus === "待人工复核"))
  }
})

test("AC-09/23: audit failure preserves sealed primary; recovery only runs unfinished audit", async () => {
  const state = transport("decoration-sub-2026", 2)
  const first = await reviewWithAgents({ ...options, fetcher: state.fetcher })
  assert.equal(first.status, "partial")
  assert.equal(first.collaboration?.primaryCompleted, true)
  assert.equal(first.collaboration?.audit?.checks.length, 3)
  const before = structuredClone(first.collaboration!.primary)
  const calls = state.roles.length
  const recovered = await reviewWithAgents({ ...options, fetcher: state.fetcher, callsUsed: first.callsUsed, previousResult: first })
  assert.equal(recovered.status, "success")
  assert.ok(state.roles.slice(calls).every(role => role === "auditor"))
  assert.deepEqual(recovered.collaboration!.primary, before)
  assert.equal(recovered.collaboration?.audit?.checks.length, 22)
  assert.ok(recovered.callsUsed <= 25)
  await assert.rejects(reviewWithAgents({ ...options, context: { role: "专业分包人", region: "北京" }, callsUsed: first.callsUsed, previousResult: first }), { code: "REVIEW_INPUT_INVALID" })
})

test("AC-23/24: role changes cannot bypass reservation, cancellation or mutate a pinned manifest", async () => {
  const state = transport("mep-sub-2026")
  const result = await reviewWithAgents({ ...options, fetcher: state.fetcher,
    onBeforeCall: async ({ callNumber }) => { if (callNumber === 2) throw new Error("revoked") } })
  assert.deepEqual(state.roles, ["router"])
  assert.equal(result.status, "failed")
  const low = await reviewWithAgents({ ...options, fetcher: state.fetcher, maxCalls: 3 })
  assert.equal(low.status, "failed")
  assert.ok(low.errors.some(item => item.code === "REVIEW_BUDGET_EXHAUSTED"))
  const controller = new AbortController(); controller.abort()
  const cancelled = await reviewWithAgents({ ...options, fetcher: state.fetcher, signal: controller.signal })
  assert.equal(cancelled.errors[0].code, "REVIEW_CANCELLED")
  await assert.rejects(reviewWithAgents({ ...options, previousResult: { ...result, collaboration: { ...result.collaboration!, manifestSha256: "changed" } }, callsUsed: result.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
})

test("AC-21: machine audit doubts or incomplete audit prevent complete no-risk presentation", async () => {
  const state = transport("mep-sub-2026")
  const result = await reviewWithAgents({ ...options, fetcher: state.fetcher })
  const clear: ReviewResult = { ...result, findings: result.findings.map(item => ({ ...item, kind: "未发现问题" })),
    coverage: result.coverage.map(item => ({ ...item, status: "未发现问题" })) }
  assert.equal(isCompleteNoRisk(clear), true)
  clear.collaboration!.audit!.checks[0] = { ...clear.collaboration!.audit!.checks[0], outcome: "需人工核对", issueTypes: ["依据支持"] }
  assert.equal(isCompleteNoRisk(clear), false)
})

test("AC-23: cumulative call cap accepts 40 and rejects 41 before any request", async () => {
  const rejected = transport("mep-sub-2026")
  await assert.rejects(reviewWithAgents({ ...options, maxCalls: 41, fetcher: rejected.fetcher }), { code: "REVIEW_INPUT_INVALID" })
  assert.equal(rejected.roles.length, 0)
  const accepted = transport("mep-sub-2026")
  const result = await reviewWithAgents({ ...options, maxCalls: 40, fetcher: accepted.fetcher })
  assert.equal(result.status, "success")
  assert.ok(result.callsUsed <= 40)
})
