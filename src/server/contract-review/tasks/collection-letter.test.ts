import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { setup } from "./test-fixtures"
import { runClaimedReview } from "./workflow"
import { createLetterDownloadHandler, type ReviewHttpServices } from "./handlers"
import { documentSkill } from "../../document-agent/skills"
import { materialText, paymentExtraction } from "../../document-agent/test-fixtures"
import { resolveLetterSources } from "../../document-agent/letter-sources"
import { parseDocxBytes } from "../../../../tools/contract-review/src/document"
import type { TaskInput } from "./repository"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-not-network" }
const plan = { sender: "合成乙公司", recipient: "合成甲公司", contractTitle: "合成分包合同", demand: "于收到本函后十日内核对并支付已到期款项", plannedDate: "2026-11-01", method: "专人递送", address: "合成测试地址" }
function transport(rejectLetter = false) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), name = body.tools[0].function.name
    calls.push(name)
    const payload = JSON.parse(body.messages.at(-1).content)
    const args = name === "submitOrganization" ? paymentExtraction() : { checks: payload.targetIds.map((id: string) => ({ id, accepted: !(rejectLetter && id === "letter"), reason: "合成模板核对。" })), gaps: [] }
    return Response.json({ id: "test-" + calls.length, object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call-" + calls.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })
  }
  return { calls, fetcher }
}
async function setupLetter(withSource = true) {
  const s = await setup(), snapshot = { id: randomUUID(), complete: true, paragraphs: [{ index: 0, text: materialText, inTable: false }], textSha256: createHash("sha256").update(materialText).digest("hex") }
  let sourceId: string | undefined
  if (withSource) {
    const request = { ...s.request, task: "payment-reconciliation" as const, asOf: "2026-10-31" }
    const input: TaskInput = { ...s.input, ...request, workflow: "document-agent-v1", skill: documentSkill("payment-reconciliation"), maxKnownTokens: 30000 }
    sourceId = (await s.repository.create(s.owner, randomUUID(), request, input, 3, 7)).id
    const job = (await s.repository.claim())!; await s.repository.snapshot(job, snapshot); job.snapshot = snapshot
    await runClaimedReview(job, { repository: s.repository, env, fetcher: transport().fetcher })
  }
  const request = { ...s.request, task: "collection-letter" as const, asOf: "2026-10-31", letterPlan: plan, ...(sourceId ? { paymentTaskId: sourceId } : {}) }
  const linked = await resolveLetterSources(s.repository, s.owner, request, s.contextId)
  const input: TaskInput = { ...s.input, ...request, workflow: "document-agent-v1", skill: documentSkill("collection-letter"), maxKnownTokens: 30000, letterSources: linked.sources }
  const created = await s.repository.create(s.owner, randomUUID(), request, input, 3, 7, linked.notAfter), job = (await s.repository.claim())!
  await s.repository.snapshot(job, snapshot); job.snapshot = snapshot
  return { s, job, request, created, sourceId }
}

test("AC-05/11/22: letter task saves a checked Word once; authorized repeated downloads return identical bytes without model calls", async () => {
  const { s, job } = await setupLetter()
  try {
    const model = transport(); await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId), letter = saved.result?.documentAnalysis?.letter
    assert.equal(saved.state, "success"); assert.ok(letter?.export); assert.match(letter.paragraphs.join(""), /500000\.00 元/)
    const file = await s.repository.letterExport(s.owner, job.id, s.contextId)
    assert.equal(createHash("sha256").update(file.bytes).digest("hex"), letter.export.sha256)
    assert.deepEqual((await s.repository.letterExport(s.owner, job.id, s.contextId)).bytes, file.bytes)
    assert.deepEqual(model.calls, ["submitOrganization", "submitVerification"])
    const services: ReviewHttpServices = { sessions: s.sessions, repository: s.repository, configuration: async () => { throw new Error("not used") }, submit: async () => { throw new Error("not used") }, submitRevision: async () => { throw new Error("not used") }, wake() {}, cancel() {} }
    const handler = createLetterDownloadHandler(async () => services)
    const response = await handler(new NextRequest("https://equilens.invalid/api/contract-reviews/" + job.id + "/letter", { headers: { Cookie: "equilens_session=" + s.token, "X-Document-Context": s.contextId } }), { params: Promise.resolve({ id: job.id }) })
    assert.equal(response.status, 200); assert.equal(response.headers.get("X-Content-SHA256"), letter.export.sha256); assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.bytes)
    s.setClock(new Date((await s.sessions.view(s.owner)).expiresAt!))
    await assert.rejects(s.repository.letterExport(s.owner, job.id, s.contextId))
  } finally { await s.close() }
})

test("AC-05/19: no payment source produces an explicitly marked draft Word, never an invented amount", async () => {
  const { s, job } = await setupLetter(false)
  try {
    await runClaimedReview(job, { repository: s.repository, env, fetcher: transport().fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId), letter = saved.result?.documentAnalysis?.letter
    assert.equal(saved.state, "partial"); assert.ok(letter?.export); assert.match(letter.paragraphs.join(""), /待补充：已到期未付金额/)
    assert.doesNotMatch(letter.paragraphs.join(""), /500000\.00 元/)
  } finally { await s.close() }
})

test("AC-08/19/22: wrong input versions, task types and cross-session sources cannot be used in letters", async () => {
  const { s, job, request, sourceId } = await setupLetter()
  try {
    for (const patch of [{ revisionId: randomUUID() }, { asOf: "2026-10-30" }, { evidenceTaskId: sourceId }]) await assert.rejects(resolveLetterSources(s.repository, s.owner, { ...request, ...patch }, s.contextId))
    await assert.rejects(resolveLetterSources(s.repository, "another-owner", request, s.contextId))
    const model = transport(true); await runClaimedReview(job, { repository: s.repository, env, fetcher: model.fetcher })
    const saved = await s.repository.get(s.owner, job.id, s.contextId)
    assert.equal(saved.result?.documentAnalysis?.letter?.export, undefined)
    await assert.rejects(s.repository.letterExport(s.owner, job.id, s.contextId))
  } finally { await s.close() }
})

test("AC-09/22: tampered Word payloads cannot be downloaded or overwrite saved exports", async () => {
  const { s, job } = await setupLetter()
  try {
    await runClaimedReview(job, { repository: s.repository, env, fetcher: transport().fetcher })
    const row = (await s.database.transaction(c => c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND stage='letter-docx'", [job.id]))).rows[0]
    const payload = JSON.parse(String(row.payload)); payload.bytes = Buffer.from("forged").toString("base64")
    await s.database.transaction(c => c.query("UPDATE equilens_review_artifacts SET payload=$1 WHERE task_id=$2 AND stage='letter-docx'", [JSON.stringify(payload), job.id]))
    await assert.rejects(s.repository.letterExport(s.owner, job.id, s.contextId), /校验失败/)
  } finally { await s.close() }
})

test("AC-05/11/22: human letter edits save a version and download only after review", async () => {
  const { s, job } = await setupLetter()
  try {
    await runClaimedReview(job, { repository: s.repository, env, fetcher: transport().fetcher })
    const machine = (await s.repository.get(s.owner, job.id, s.contextId)).result!.documentAnalysis!
    const paragraphs = [...machine.letter!.paragraphs]
    paragraphs[3] = paragraphs[3] + "（人工核对：金额与到期日已复核）"
    const revision = await s.repository.saveDocumentRevision(s.owner, job.id, s.contextId, {
      baseVersionId: "machine", extraction: machine.extraction, letterParagraphs: paragraphs, changeReason: "补充人工核对说明", createdBy: "复核人甲" })
    await assert.rejects(s.repository.reviewedLetterExport(s.owner, job.id, s.contextId, revision.versionId), { status: 409 })
    await s.repository.reviewDocumentRevision(s.owner, job.id, s.contextId, revision.versionId, { decision: "通过", reviewer: "复核人乙", note: "正文核对通过。" })
    const file = await s.repository.reviewedLetterExport(s.owner, job.id, s.contextId, revision.versionId)
    assert.ok(parseDocxBytes(file.bytes).paragraphs.some(item => item.text === paragraphs[3]))
  } finally { await s.close() }
})
