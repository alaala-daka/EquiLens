import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import type { DocumentExtraction } from "../../../lib/document-agent/types"
import { paymentExtraction, materialText } from "../../document-agent/test-fixtures"
import { documentSkill } from "../../document-agent/skills"
import { runClaimedReview } from "./workflow"
import { setup } from "./test-fixtures"
import type { TaskInput } from "./repository"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-not-network" }
function transport(data: DocumentExtraction) {
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), name = body.tools[0].function.name as string
    const input = name === "submitOrganization" ? data : { checks: (JSON.parse(body.messages.at(-1).content).targetIds as string[]).map(id => ({ id, accepted: true, reason: "合成核对。" })), gaps: [] }
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(input) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })
  }
  return { fetcher }
}
async function completed() {
  const s = await setup(), skill = documentSkill("payment-reconciliation")
  const request = { ...s.request, task: "payment-reconciliation" as const, asOf: "2026-10-31", context: { ...s.request.context, region: "" }, unreviewedMaterialsConsent: false }
  const input: TaskInput = { ...s.input, ...request, workflow: "document-agent-v1", skill, maxKnownTokens: 30000 }
  const created = await s.repository.create(s.owner, randomUUID(), request, input, 3, 7)
  const job = (await s.repository.claim())!
  const snapshot = { id: randomUUID(), complete: true, paragraphs: [{ index: 0, text: materialText, inTable: false }], textSha256: createHash("sha256").update(materialText).digest("hex") }
  await s.repository.snapshot(job, snapshot); job.snapshot = snapshot
  await runClaimedReview(job, { repository: s.repository, env, fetcher: transport(paymentExtraction()).fetcher })
  return { s, taskId: created.id }
}

test("AC-06/09/19: human revisions are immutable versions and review records bind to the exact version", async () => {
  const { s, taskId } = await completed()
  try {
    const initial = await s.repository.documentRevisions(s.owner, taskId, s.contextId)
    assert.equal(initial.machine.versionId, "machine")
    assert.equal(initial.machine.analysis.task, "payment-reconciliation")
    const extraction = structuredClone(paymentExtraction())
    extraction.amounts[1].label = "人工确认的本期付款"
    extraction.gaps = ["人工补充：核对付款凭证原件。"]
    const first = await s.repository.saveDocumentRevision(s.owner, taskId, s.contextId, {
      baseVersionId: "machine", extraction, changeReason: "人工补充付款核对说明", createdBy: "复核人甲" })
    assert.equal(first.versionNumber, 1)
    assert.equal(first.baseVersionId, "machine")
    assert.equal(first.analysis.extraction?.amounts[1].label, "人工确认的本期付款")
    const listed = await s.repository.documentRevisions(s.owner, taskId, s.contextId)
    assert.equal(listed.revisions.length, 1)
    assert.equal(listed.revisions[0].sha256, first.sha256)
    await assert.rejects(s.repository.saveDocumentRevision(s.owner, taskId, s.contextId, {
      baseVersionId: "machine", extraction, changeReason: "过期基础版本", createdBy: "复核人甲" }), { status: 409 })
    await s.repository.reviewDocumentRevision(s.owner, taskId, s.contextId, first.versionId, { decision: "通过", reviewer: "复核人乙", note: "核对通过。" })
    const reviewed = await s.repository.documentRevisions(s.owner, taskId, s.contextId)
    assert.equal(reviewed.revisions[0].review?.decision, "通过")
    assert.equal(reviewed.revisions[0].review?.versionId, first.versionId)
    const unchanged = await s.repository.documentRevisions(s.owner, taskId, s.contextId)
    assert.equal(unchanged.machine.analysis.extraction?.amounts[1].label, "本期已付")
  } finally { await s.close() }
})

test("AC-07/09/24: invalid citations or stale bases cannot become a human version", async () => {
  const { s, taskId } = await completed()
  try {
    const extraction = structuredClone(paymentExtraction())
    extraction.amounts[0].source.quote = "伪造引文"
    await assert.rejects(s.repository.saveDocumentRevision(s.owner, taskId, s.contextId, {
      baseVersionId: "machine", extraction, changeReason: "伪造", createdBy: "复核人甲" }), { status: 422 })
    await assert.rejects(s.repository.reviewDocumentRevision(s.owner, taskId, s.contextId, randomUUID(), { decision: "通过", reviewer: "复核人", note: "" }), { status: 404 })
  } finally { await s.close() }
})
