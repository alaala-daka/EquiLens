import assert from "node:assert/strict"
import { before, test } from "node:test"
import { loadSceneBundles, type SceneBundle } from "../src/bundles"
import { reviewWithAgents, reviewRevisionOnly } from "../src/agent/pipeline"
import { canExportRevision } from "../src/revision"
import { draftHash, REVISION_AUDIT_BATCH_SIZE } from "../src/agent/revision"

const text = "合成房屋建筑专业分包合同，双方应约定履约安排。"
const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
let bundles: SceneBundle[]
before(async () => { bundles = await loadSceneBundles() })

export function revisionTransport(bundle: SceneBundle, inputText: string, refuseAuditAt = 0, unsafe = false) {
  let primaryStep = 0, revisionOffset = 0, auditCalls = 0, refused = false
  const roles: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), menu = body.tools.map((item: { function: { name: string } }) => item.function.name)
    let name = menu[0], input: unknown
    if (name === "selectScene") {
      roles.push("router")
      input = { status: "matched", sceneId: bundle.candidate.id, reason: "合成匹配。", evidence: [{ paragraphIndex: 0, quote: inputText }], missingInfo: [] }
    } else if (name === "submitRevision") {
      roles.push("reviser")
      const data = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content)
      const ids = data.findings.map((item: { ruleId: string }) => item.ruleId)
      if (data.targetRuleIds) {
        const changed = data.savedEdits.length === 0
        input = { edits: changed ? [{ id: "E1", operation: "replace", paragraphIndex: 0, before: inputText, after: inputText + "双方应书面确认相关履约安排。", ruleIds: ids }] : [],
          decisions: ids.map((ruleId: string) => ({ ruleId, action: changed ? "changed" : "pending", editIds: changed ? ["E1"] : [], reason: changed ? "补充书面确认安排。" : "合成共享段落需人工确认。" })) }
      } else {
      input = { edits: revisionOffset === 0 ? [{ id: "E1", operation: "replace", paragraphIndex: 0, before: inputText,
        after: inputText + "双方应书面确认相关履约安排。", ruleIds: ids }] : [],
      decisions: ids.slice(revisionOffset, revisionOffset + 6).map((ruleId: string) => ({ ruleId, action: "changed", editIds: ["E1"], reason: "补充书面确认安排。" })) }
      revisionOffset += 6
      }
    } else if (name === "submitRevisionAudit") {
      roles.push("auditor"); auditCalls++
      if (auditCalls === refuseAuditAt && !refused) { refused = true; return Response.json({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }) }
      const data = JSON.parse(body.messages.at(-1).content)
      input = { checks: data.targetRuleIds.map((ruleId: string, index: number) => ({ ruleId,
        outcome: unsafe && auditCalls === 1 && index === 0 ? "存在问题" : data.decisions.some((item: { ruleId: string; action: string }) => item.ruleId === ruleId && item.action === "pending") ? "需确认" : "已处理", note: unsafe ? "合成核对发现问题。" : "合成核对，仍待人工审核。",
        paragraphIndex: 0, quote: data.revisedParagraphs[0].text, basis: [bundle.pack.rules.find(rule => rule.ruleId === ruleId)!.basis[0].sourceId] })) }
    } else {
      roles.push("primary"); primaryStep++
      if (name === "submitFindings") {
        const data = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content)
        input = { findings: data.targetRuleIds.map((ruleId: string) => ({ ruleId, kind: "发现问题", risk: "合成检查问题。", severity: "一般关注", quote: inputText,
          paragraphIndex: 0, basis: [bundle.pack.rules.find(rule => rule.ruleId === ruleId)!.basis[0].sourceId], impact: "", suggestion: "补充书面确认。", pending: [] })) }
      } else if (primaryStep === 1) { name = "loadSkill"; input = { skillId: bundle.skill.id } }
      else if (primaryStep === 2) { name = "readParagraphs"; input = { indexes: [0] } }
      else if (primaryStep === 3) { name = "readSources"; input = { sourceIds: [...new Set(bundle.pack.rules.flatMap(rule => rule.basis.map(item => item.sourceId)))] } }
      else { name = "submitFindings"; input = { findings: bundle.pack.rules.slice((primaryStep - 4) * 3, (primaryStep - 3) * 3).map(rule => ({ ruleId: rule.ruleId,
        kind: "发现问题", risk: "合成检查问题。", severity: rule.severity, quote: inputText, paragraphIndex: 0, basis: [rule.basis[0].sourceId], impact: "", suggestion: "补充书面确认。", pending: [] })) } }
    }
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "call-" + roles.length, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  return { fetcher, roles }
}
const options = () => ({ bundles, documentText: text, context: { role: "专业分包人", region: "上海" }, mode: "debug" as const,
  env, maxCalls: 25, workflow: "multi-agent-revision-v1" as const })

test("AC-03/11/23: four revision skills run primary → revised body → independent revised-body audit", async () => {
  assert.equal(new Set(bundles.map(bundle => bundle.revisionSkill!.id)).size, 4)
  for (const bundle of bundles) {
    const state = revisionTransport(bundle, text), reservations: number[] = []
    const result = await reviewWithAgents({ ...options(), fetcher: state.fetcher, onBeforeCall: async value => { reservations.push(value.callNumber) } })
    assert.equal(result.status, "success")
    assert.equal(result.collaboration?.revision?.skillSha256, bundle.revisionSkill!.sha256)
    assert.ok(canExportRevision(result.collaboration?.revision, result.collaboration?.revisionAudit))
    assert.equal(result.collaboration?.revision?.decisions.length, bundle.pack.rules.length)
    assert.equal(result.collaboration?.revisionAudit?.checks.length, bundle.pack.rules.length)
    assert.equal(result.collaboration?.primary?.paragraphs[0].text, text)
    assert.notEqual(result.collaboration?.revision?.paragraphs[0].text, text)
    assert.ok(!state.roles.slice(state.roles.indexOf("auditor")).includes("reviser"))
    assert.deepEqual(reservations, state.roles.map((_, index) => index + 1))
    assert.equal(result.callsUsed, state.roles.length)
    assert.equal(result.usage?.totalTokens, state.roles.length * 15)
    assert.ok(result.callsUsed <= 25)
  }
})

test("AC-09/23: revised-body audit recovery preserves the exact draft and skips finished roles", async () => {
  const state = revisionTransport(bundles[1], text, 2)
  const first = await reviewWithAgents({ ...options(), fetcher: state.fetcher })
  assert.equal(first.status, "partial")
  assert.equal(first.collaboration?.revisionAudit?.checks.length, REVISION_AUDIT_BATCH_SIZE)
  const sha = first.collaboration!.revision!.sha256, primary = structuredClone(first.collaboration!.primary)
  const offset = state.roles.length
  const second = await reviewWithAgents({ ...options(), fetcher: state.fetcher, callsUsed: first.callsUsed, previousResult: first })
  assert.equal(second.status, "success")
  assert.equal(second.collaboration?.revision?.sha256, sha)
  assert.deepEqual(second.collaboration?.primary, primary)
  assert.ok(state.roles.slice(offset).every(role => role === "auditor"))
})

test("AC-09/23: 18-call checkpoint finishes the remaining decision and all 19 checks within its original 25-call budget", async () => {
  const bundle = bundles.find(item => item.pack.rules.length === 19)!
  const initial = revisionTransport(bundle, text)
  const previous = await reviewWithAgents({ ...options(), fetcher: initial.fetcher })
  const primary = structuredClone(previous.collaboration!.primary)
  const draft = previous.collaboration!.revision!
  // Synthetic checkpoint matching the real failure: saved edits, one missing decision, no audit yet.
  const missing = draft.decisions.pop()!
  draft.callsUsed = previous.callsUsed = 18
  draft.status = "partial"
  draft.sha256 = draftHash(draft)
  previous.collaboration!.revisionAudit = undefined
  previous.collaboration!.phase = "revising"
  previous.status = "partial"
  const edits = structuredClone(draft.edits), reservations: number[] = []
  const audit = revisionTransport(bundle, text)
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools[0].function.name !== "submitRevision") return audit.fetcher(url, init)
    return Response.json({ id: "synthetic-recovery", object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "remaining-decision", type: "function", function: { name: "submitRevision", arguments: JSON.stringify({ edits: [], decisions: [missing] }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  const result = await reviewWithAgents({ ...options(), fetcher, previousResult: previous, callsUsed: 18,
    onBeforeCall: async value => { reservations.push(value.callNumber) } })
  assert.equal(result.status, "success")
  assert.deepEqual(reservations, Array.from({ length: reservations.length }, (_, index) => 19 + index))
  assert.ok(reservations.length <= 7)
  assert.deepEqual(result.collaboration!.primary, primary)
  assert.deepEqual(result.collaboration!.revision!.edits, edits)
  assert.equal(result.collaboration!.revisionAudit!.checks.length, 19)
  assert.ok(canExportRevision(result.collaboration!.revision, result.collaboration!.revisionAudit))
})

test("AC-11/21/24: unsafe revised contracts and revoked reservations never become exportable", async () => {
  const unsafe = revisionTransport(bundles[0], text, 0, true)
  const rejected = await reviewWithAgents({ ...options(), fetcher: unsafe.fetcher })
  assert.equal(rejected.status, "partial")
  assert.ok(rejected.errors.some(item => item.code === "REVIEW_REVISION_UNSAFE"))
  assert.equal(canExportRevision(rejected.collaboration?.revision, rejected.collaboration?.revisionAudit), false)
  const state = revisionTransport(bundles[0], text)
  const result = await reviewWithAgents({ ...options(), fetcher: state.fetcher, onBeforeCall: async value => {
    if (value.callNumber === 12) throw new Error("revoked")
  } })
  assert.ok(!state.roles.includes("reviser"))
  assert.equal(canExportRevision(result.collaboration?.revision, result.collaboration?.revisionAudit), false)
})

test("AC-03/09/23: four prepared scene workflows retain all checks, low revision effort and pinned recovery policy", async () => {
  for (const bundle of bundles) {
    const state = revisionTransport(bundle, text), efforts: string[] = []
    const settings = { ...options(), primaryStrategy: "prepared-v1" as const, revisionStrategy: "prepared-v1" as const, auditStrategy: "prepared-v1" as const, primaryEffort: "low" as const, revisionEffort: "low" as const, maxKnownTokens: 250000 }
    const result = await reviewWithAgents({ ...settings, fetcher: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (["submitFindings", "submitRevision"].includes(body.tools[0].function.name)) efforts.push(body.reasoning_effort)
      return state.fetcher(url, init)
    } })
    assert.equal(result.status, "success")
    assert.equal(result.collaboration!.primary!.agent!.preparation!.receipts.length, 6)
    assert.equal(state.roles.filter(role => role === "primary").length, 6)
    assert.ok(efforts.every(value => value === "low"))
    assert.ok(canExportRevision(result.collaboration!.revision, result.collaboration!.revisionAudit))
    await assert.rejects(reviewWithAgents({ ...settings, primaryStrategy: undefined, callsUsed: result.callsUsed, previousResult: result, fetcher: state.fetcher }), { code: "REVIEW_INPUT_INVALID" })
  }
})

test("AC-23: aggregated known-token gate stops before sending another role without changing the call count", async () => {
  const state = revisionTransport(bundles[0], text)
  const result = await reviewWithAgents({ ...options(), primaryStrategy: "prepared-v1", maxKnownTokens: 10000,
    fetcher: async (url, init) => {
      const data = await (await state.fetcher(url, init)).json()
      data.usage = { prompt_tokens: 9990, completion_tokens: 10, total_tokens: 10000 }
      return Response.json(data)
    } })
  assert.deepEqual(state.roles, ["router"])
  assert.equal(result.callsUsed, 1)
  assert.ok(result.errors.some(item => item.code === "REVIEW_TOKEN_BUDGET_EXHAUSTED"))
  assert.equal(canExportRevision(result.collaboration!.revision, result.collaboration!.revisionAudit), false)
})

test("AC-09/11/23: one targeted repair preserves the original and rechecks every rule once", async () => {
  const bundle = bundles.find(item => item.pack.rules.length === 19)!
  const state = revisionTransport(bundle, text, 0, true)
  let repairs = 0
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools[0].function.name !== "submitRepair") return state.fetcher(url, init)
    repairs++
    const data = JSON.parse(body.messages.find((item: { role: string }) => item.role === "user").content)
    const id = data.problems[0].ruleId
    const previous = data.decisions.find((item: { ruleId: string }) => item.ruleId === id)
    const argument = { removeEditIds: [], edits: [{ id: "repair-1", operation: "insert-after", paragraphIndex: 0, before: text,
      after: "双方应补充书面确认程序。", ruleIds: [id] }], decisions: [{ ...previous, action: "changed", editIds: [...previous.editIds, "repair-1"], reason: "补充确认程序。" }] }
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0,
      finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "repair", type: "function", function: { name: "submitRepair", arguments: JSON.stringify(argument) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  const settings = { ...options(), primaryStrategy: "prepared-v1" as const, revisionStrategy: "prepared-v1" as const, auditStrategy: "prepared-v1" as const, repairStrategy: "one-round-v1" as const }
  const result = await reviewWithAgents({ ...settings, fetcher })
  assert.equal(repairs, 1)
  assert.equal(result.collaboration?.revisionRepair?.status, "repaired")
  assert.notEqual(result.collaboration?.revision?.sha256, result.collaboration?.revisionRepair?.originalDraft.sha256)
  assert.equal(result.collaboration?.revisionRepair?.originalAudit.checks.filter(item => item.outcome === "存在问题").length, 1)
  assert.equal(result.collaboration?.revisionAudit?.checks.length, 19)
  assert.equal(result.usage?.totalTokens, result.callsUsed * 15)
  assert.ok(canExportRevision(result.collaboration?.revision, result.collaboration?.revisionAudit))
  const resumed = await reviewWithAgents({ ...settings, fetcher, previousResult: result, callsUsed: result.callsUsed })
  assert.equal(repairs, 1)
  assert.ok(canExportRevision(resumed.collaboration?.revision, resumed.collaboration?.revisionAudit))
  const unresolved = structuredClone(resumed)
  unresolved.collaboration!.revisionAudit!.checks[0].outcome = "存在问题"
  const stopped = await reviewWithAgents({ ...settings, fetcher, previousResult: unresolved, callsUsed: unresolved.callsUsed })
  assert.equal(repairs, 1)
  assert.equal(canExportRevision(stopped.collaboration?.revision, stopped.collaboration?.revisionAudit), false)
})

test("AC-11/23: insufficient budget never starts repair or bypasses the unsafe audit", async () => {
  const bundle = bundles.find(item => item.pack.rules.length === 19)!
  const state = revisionTransport(bundle, text, 0, true)
  const result = await reviewWithAgents({ ...options(), maxCalls: 17, primaryStrategy: "prepared-v1", revisionStrategy: "prepared-v1", auditStrategy: "prepared-v1", repairStrategy: "one-round-v1", fetcher: state.fetcher })
  assert.equal(result.collaboration?.revisionRepair, undefined)
  assert.equal(canExportRevision(result.collaboration?.revision, result.collaboration?.revisionAudit), false)
})

test("AC-23: a recorded but interrupted repair is never repeated on recovery", async () => {
  const bundle = bundles.find(item => item.pack.rules.length === 19)!
  const state = revisionTransport(bundle, text, 0, true)
  const settings = { ...options(), primaryStrategy: "prepared-v1" as const, revisionStrategy: "prepared-v1" as const, auditStrategy: "prepared-v1" as const, repairStrategy: "one-round-v1" as const }
  let checkpoint: import("../src/types").ReviewResult | undefined
  await reviewWithAgents({ ...settings, fetcher: state.fetcher, onCheckpoint: async value => {
    if (value.collaboration?.revisionRepair?.status === "started") { checkpoint = structuredClone(value); throw new Error("synthetic crash") }
  } })
  assert.ok(checkpoint)
  const rolesBefore = state.roles.length
  const resumed = await reviewWithAgents({ ...settings, previousResult: checkpoint, callsUsed: checkpoint.callsUsed, fetcher: state.fetcher })
  assert.equal(state.roles.length, rolesBefore)
  assert.equal(resumed.collaboration?.revisionRepair?.status, "failed")
  assert.equal(canExportRevision(resumed.collaboration?.revision, resumed.collaboration?.revisionAudit), false)
})

test("AC-09/23/24: revision-only reuses the saved primary, revises and audits only selected rules without routing or primary calls", async () => {
  const bundle = bundles[0]
  const reviewed = await reviewWithAgents({ ...options(), fetcher: revisionTransport(bundle, text).fetcher })
  assert.equal(reviewed.status, "success")
  // 仅修订任务只接受已保存的纯审查结果；这里复用修订跑出的主审快照并按其纯审查版本固定。
  const primary: import("../src/types").ReviewResult = { ...structuredClone(reviewed),
    collaboration: { ...structuredClone(reviewed.collaboration!), version: "multi-agent-v1", phase: "completed", revision: undefined, revisionAudit: undefined } }
  const targets = primary.findings.filter(item => item.kind === "发现问题").slice(0, 2).map(item => item.ruleId)
  assert.equal(targets.length, 2)
  const state = revisionTransport(bundle, text)
  const result = await reviewRevisionOnly({ primary, ruleIds: targets, bundles: [bundle], env, fetcher: state.fetcher, maxCalls: 10 })
  assert.equal(result.status, "success")
  assert.equal(result.collaboration?.version, "revision-only-v1")
  assert.deepEqual(state.roles, ["reviser", "auditor"])
  assert.deepEqual(result.collaboration?.revision?.decisions.map(item => item.ruleId).sort(), [...targets].sort())
  assert.deepEqual(result.collaboration?.revisionAudit?.checks.map(item => item.ruleId).sort(), [...targets].sort())
  assert.equal(canExportRevision(result.collaboration?.revision, result.collaboration?.revisionAudit), true)
  assert.equal(result.usage?.totalTokens, 30)
  assert.deepEqual(result.collaboration?.primary, primary)
  await assert.rejects(reviewRevisionOnly({ primary, ruleIds: ["UNKNOWN"], bundles: [bundle], env, fetcher: state.fetcher, maxCalls: 10 }), { code: "REVIEW_INPUT_INVALID" })
})
