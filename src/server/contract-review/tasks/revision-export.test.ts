import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { setup } from "./test-fixtures"
import { revisionFixture } from "../../../../tools/contract-review/tests/revision-fixture"
import { buildRevisionDocx } from "../../../../tools/contract-review/src/revision-docx"
import { draftHash, revisionHash } from "../../../../tools/contract-review/src/agent/revision"
import { createReviewRevisionHandler } from "./handlers"
import type { ReviewResult } from "../../../lib/contract-reviews/types"

async function savedRevision() {
  const fixture = await revisionFixture()
  const s = await setup(new Blob([new Uint8Array(fixture.bytes)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))
  const request = { ...s.request, generateRevision: true }
  const task = await s.repository.create(s.owner, randomUUID(), request, { ...s.input, ...request, workflow: "multi-agent-revision-v1" }, 25, 7)
  const job = (await s.repository.claim())!
  const snapshot = { id: randomUUID(), paragraphs: fixture.primary.paragraphs, complete: true, textSha256: fixture.primary.input.textSha256 }
  await s.repository.snapshot(job, snapshot); job.snapshot = snapshot
  fixture.primary.input.documentVersionId = s.input.revisionId; fixture.primary.input.parseSnapshotId = snapshot.id
  fixture.draft.primarySha256 = revisionHash(fixture.primary); fixture.draft.sha256 = draftHash(fixture.draft)
  fixture.audit.primarySha256 = fixture.draft.primarySha256; fixture.audit.draftSha256 = fixture.draft.sha256
  const result: ReviewResult = { ...structuredClone(fixture.primary), collaboration: { version: "multi-agent-revision-v1", manifestSha256: "synthetic", phase: "completed", primaryCompleted: true,
    primary: fixture.primary, revision: fixture.draft, revisionAudit: fixture.audit } }
  const bytes = Buffer.from(buildRevisionDocx(fixture.bytes, fixture.primary, fixture.draft, fixture.audit))
  return { ...fixture, s, task, job, result, bytes }
}

test("AC-01/09/11/23: revision artifacts are immutable, version-bound and require the current execution token", async () => {
  const { s, job, result, bytes } = await savedRevision()
  try {
    const before = (await s.repository.readRevision(s.owner, job.input.documentId, job.input.revisionId, s.contextId)).hash
    const unsafe = structuredClone(result)
    unsafe.collaboration!.revisionAudit!.checks[0].outcome = "存在问题"
    await assert.rejects(s.repository.saveRevisionExport(job, unsafe, bytes, 1), { status: 409 })
    await assert.rejects(s.repository.saveRevisionExport({ ...job, snapshot: null }, result, bytes, 1), { status: 409 })
    const saved = await s.repository.saveRevisionExport(job, result, bytes, 1)
    assert.ok(saved.collaboration?.revision?.export)
    await assert.rejects(s.repository.revisionExport(s.owner, job.id, s.contextId), { status: 409 })
    const repeated = await s.repository.saveRevisionExport(job, result, bytes, 2)
    assert.equal(repeated.collaboration!.revision!.export!.sha256, saved.collaboration!.revision!.export!.sha256)
    await s.repository.finish(job, saved, null, 3)
    const one = await s.repository.revisionExport(s.owner, job.id, s.contextId)
    const two = await s.repository.revisionExport(s.owner, job.id, s.contextId)
    assert.deepEqual(one.bytes, bytes); assert.deepEqual(two.bytes, bytes)
    assert.equal(one.sha256, createHash("sha256").update(bytes).digest("hex"))
    assert.equal((await s.repository.readRevision(s.owner, job.input.documentId, job.input.revisionId, s.contextId)).hash, before)
    await assert.rejects(s.repository.saveRevisionExport(job, result, bytes, 4), { status: 409 })
    const other = createHash("sha256").update("other synthetic owner").digest("hex")
    const otherSession = await s.sessions.view(other)
    await assert.rejects(s.repository.revisionExport(other, job.id, otherSession.contextId), { status: 404 })
    await s.database.transaction(c => c.query("UPDATE equilens_review_artifacts SET payload=$1 WHERE task_id=$2 AND stage='revision-docx'", [JSON.stringify({ bytes: bytes.toString("base64"), sha256: "changed" }), job.id]))
    await assert.rejects(s.repository.revisionExport(s.owner, job.id, s.contextId), { status: 500 })
  } finally { await s.close() }
})

test("AC-01/11/23: Word downloads recheck session, return saved bytes and stop after expiry", async t => {
  const { s, job, result, bytes } = await savedRevision()
  try {
    const saved = await s.repository.saveRevisionExport(job, result, bytes, 1)
    await s.repository.finish(job, saved, null, 2)
    const handler = createReviewRevisionHandler(async () => ({ sessions: s.sessions, repository: s.repository,
      configuration: async () => ({ ready: false, mode: "debug", model: "", providerHost: "", retentionDays: 0, maxKnownTokens: 0, configurationId: "" }),
      submit: async () => { throw new Error("download must not submit") }, submitRevision: async () => { throw new Error("download must not submit") },
      wake: () => { throw new Error("download must not wake") }, cancel: () => {} }))
    const request = () => new NextRequest("https://equilens.invalid/api/contract-reviews/" + job.id + "/revision", { headers: { Cookie: `equilens_session=${s.token}`, "X-Document-Context": s.contextId } })
    const context = { params: Promise.resolve({ id: job.id }) }
    const response = await handler(request(), context)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    assert.equal(response.headers.get("X-Document-Context"), s.contextId)
    assert.match(response.headers.get("Content-Disposition")!, /attachment/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const expiration = new Date((await s.sessions.view(s.owner)).expiresAt!)
    const original = s.repository.revisionExport.bind(s.repository)
    t.mock.method(s.repository, "revisionExport", async (...args: Parameters<typeof original>) => { const file = await original(...args); s.setClock(expiration); return file })
    const expired = await handler(request(), context)
    assert.equal(expired.status, 410)
    assert.equal((await expired.json()).code, "RETENTION_EXPIRED")
  } finally { await s.close() }
})
