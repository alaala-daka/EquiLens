import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import type { DocumentExtraction, DocumentTaskKind } from "../../../lib/document-agent/types"
import { paymentExtraction, evidenceExtraction, materialText } from "../../document-agent/test-fixtures"
import { documentSkill } from "../../document-agent/skills"
import { toMarkdown } from "../../../../tools/contract-review/src/report"
import { runClaimedReview } from "./workflow"
import { setup } from "./test-fixtures"
import type { TaskInput } from "./repository"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-not-network" }
async function jobFor(task: DocumentTaskKind = "payment-reconciliation", tokenLimit = 30000) {
  const s = await setup(), skill = documentSkill(task)
  const request = { ...s.request, task, asOf: "2026-10-31", context: { ...s.request.context, region: "" }, unreviewedMaterialsConsent: false }
  const input: TaskInput = { ...s.input, ...request, workflow: "document-agent-v1", skill, maxKnownTokens: tokenLimit }
  const created = await s.repository.create(s.owner, randomUUID(), request, input, 3, 7)
  const job = (await s.repository.claim())!
  const snapshot = { id: randomUUID(), complete: true, paragraphs: [{ index: 0, text: materialText, inTable: false }], textSha256: createHash("sha256").update(materialText).digest("hex") }
  await s.repository.snapshot(job, snapshot); job.snapshot = snapshot
  return { s, job, created }
}
function transport(data: DocumentExtraction, options: { auditFails?: boolean; malformed?: number; usage?: number; rejectAudit?: boolean } = {}) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), name = body.tools[0].function.name as string
    assert.ok(body.tool_choice === undefined || body.tool_choice === "auto", "Thinking models reject forced named tool choices")
    calls.push(name)
    if (name === "submitVerification" && options.auditFails) return new Response("synthetic unavailable", { status: 503 })
    const input = name === "submitOrganization" ? data : { checks: (JSON.parse(body.messages.at(-1).content).targetIds as string[]).map(id => ({ id, accepted: !options.rejectAudit, reason: options.rejectAudit ? "材料存在疑点。" : "与所列原文相符，仍待人工复核。" })), gaps: [] }
    return Response.json({ id: "synthetic-" + calls.length, object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "call-" + calls.length, type: "function", function: { name, arguments: calls.length <= (options.malformed ?? 0) ? "{}" : JSON.stringify(input) } }] } }],
      usage: { prompt_tokens: options.usage ?? 100, completion_tokens: 50, total_tokens: (options.usage ?? 100) + 50 } })
  }
  return { fetcher, calls }
}

test("AC-06/20/23: payment Agent runs two independent calls through the actual persistent runner", async () => {
  const { s, job } = await jobFor()
  try {
    const model = transport(paymentExtraction())
    await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.kind, "payment-reconciliation"); assert.equal(saved.state, "success"); assert.equal(saved.callsUsed, 2)
    assert.deepEqual(model.calls, ["submitOrganization", "submitVerification"])
    assert.equal(saved.result?.documentAnalysis?.calculation?.unpaidFen, "50000000")
    assert.equal(saved.result?.usage?.totalTokens, 300)
    const before = model.calls.length, markdown = toMarkdown(saved.result!)
    assert.match(markdown, /500000\.00 元/); assert.equal(toMarkdown((await s.repository.get(s.owner, job.id, s.contextId)).result!), markdown)
    assert.equal(model.calls.length, before)
    await assert.rejects(s.repository.checkpoint(job, "organizing", saved.progress, saved.result!, 100))
  } finally { await s.close() }
})

test("AC-06/19: contract-only input yields payment terms and material gaps, never a fabricated debt", async () => {
  const { s, job } = await jobFor()
  try {
    const data = paymentExtraction(); data.amounts = []; data.paymentCoverage = false; data.gaps = ["请补充计量确认、到期依据和收付款记录。"]
    data.terms = [{ title: "付款比例", detail: "合同记载按80%支付，不证明款项已到期。", sources: [{ paragraphIndex: 0, quote: materialText }] }]
    const model = transport(data)
    await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.state, "partial"); assert.equal(saved.result?.documentAnalysis?.calculation, null)
    assert.match(toMarkdown(saved.result!), /请补充计量确认/); assert.equal(saved.result?.documentAnalysis?.audit.complete, true)
  } finally { await s.close() }
})

test("AC-07/08/22: evidence Agent preserves timeline, dispute, fixed citations and reproducible report", async () => {
  const { s, job } = await jobFor("evidence-organization")
  try {
    const model = transport(evidenceExtraction())
    await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.state, "success"); assert.equal(saved.result?.documentAnalysis?.extraction?.events[0].date, "2026-10-30")
    assert.match(toMarkdown(saved.result!), /证据时间线/); assert.match(toMarkdown(saved.result!), /争点/)
    assert.equal(saved.result?.input.parseSnapshotId, job.snapshot!.id)
    await assert.rejects(s.repository.get("other-owner", job.id, s.contextId))
  } finally { await s.close() }
})

test("AC-08/20: a retained machine opinion cannot waive invalid quotes or mismatched monetary units", async () => {
  const { s, job } = await jobFor()
  try {
    const data = paymentExtraction(); data.amounts[0].amountYuan = "10000"
    await runClaimedReview(job, { repository: s.repository, env, fetcher: transport(data).fetcher })
    const result = (await s.repository.get(s.owner, job.id, s.contextId)).result!
    assert.equal(result.documentAnalysis?.rejected[0].id, "amount:0"); assert.equal(result.documentAnalysis?.calculation, null); assert.equal(result.status, "partial")
  } finally { await s.close() }
})

test("AC-09/23: one structure repair is bounded by the shared three-call budget", async () => {
  const { s, job } = await jobFor()
  try {
    const model = transport(paymentExtraction(), { malformed: 1 })
    await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.state, "success"); assert.equal(saved.callsUsed, 3)
    assert.deepEqual(model.calls, ["submitOrganization", "submitOrganization", "submitVerification"])
  } finally { await s.close() }
})

test("AC-09/23: audit recovery reuses the saved organization and never resets usage or calls", async () => {
  const { s, job } = await jobFor()
  try {
    const first = transport(paymentExtraction(), { auditFails: true })
    await runClaimedReview(job, { repository: s.repository, env, fetcher: first.fetcher })
    const partial = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(partial.state, "partial"); assert.ok(partial.result?.documentAnalysis?.extraction)
    assert.equal(partial.callsUsed, 2)
    await s.repository.action(s.owner, job.id, "retry", s.contextId)
    const next = (await s.repository.claim())!, second = transport(paymentExtraction())
    await runClaimedReview(next, { repository: s.repository, env, fetcher: second.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.callsUsed, 3); assert.equal(saved.state, "success"); assert.deepEqual(second.calls, ["submitVerification"])
    assert.equal(saved.result?.usage?.totalTokens, 300)
  } finally { await s.close() }
})

test("AC-23: persisted token usage stops audit before another external request", async () => {
  const { s, job } = await jobFor("payment-reconciliation", 10000)
  try {
    const model = transport(paymentExtraction(), { usage: 10000 })
    await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.callsUsed, 1); assert.equal(saved.error?.code, "REVIEW_TOKEN_BUDGET_EXHAUSTED")
    assert.equal(saved.result?.documentAnalysis?.audit.complete, false); assert.equal(saved.result?.documentAnalysis?.calculation, null)
  } finally { await s.close() }
})
