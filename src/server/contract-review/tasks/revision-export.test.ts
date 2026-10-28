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
import { StoreError } from "../../documents/errors"

async function linkedRevisionTasks() {
  const s = await setup()
  const source = await s.create()
  const request = { ...s.request, generateRevision: true }
  const input = { ...s.input, ...request, workflow: "revision-only-v1" as const, revisionSource: { taskId: source.id, ruleIds: ["T-001"] } }
  const child = await s.repository.create(s.owner, randomUUID(), request, input, 25, 7)
  return { s, source, child, input }
}

function downloadHandler(s: Awaited<ReturnType<typeof setup>>) {
  return createReviewRevisionHandler(async () => ({ sessions: s.sessions, repository: s.repository,
    configuration: async () => ({ ready: false, mode: "debug", model: "", providerHost: "", retentionDays: 0, maxKnownTokens: 0, configurationId: "" }),
    submit: async () => { throw new Error("download must not submit") }, submitRevision: async () => { throw new Error("download must not submit") },
    wake: () => { throw new Error("download must not wake") }, cancel: () => {} }))
}

function downloadRequest(s: Awaited<ReturnType<typeof setup>>, id: string) {
  return new NextRequest("https://equilens.invalid/api/contract-reviews/" + id + "/revision", {
    headers: { Cookie: `equilens_session=${s.token}`, "X-Document-Context": s.contextId },
  })
}

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

test("AC-01/11：原审查ID返回明确修订任务提示，未生成与任务ID用错分别处理，不自动下载", async () => {
  const { s, source, child } = await linkedRevisionTasks()
  try {
    await assert.rejects(s.repository.revisionExport(s.owner, source.id, s.contextId), {
      status: 409, code: "REVISION_TASK_REQUIRED", revisionTaskId: child.id,
    })
    await assert.rejects(s.repository.revisionExport(s.owner, child.id, s.contextId), { status: 409, code: "REVISION_NOT_READY" })
    const response = await downloadHandler(s)(downloadRequest(s, source.id), { params: Promise.resolve({ id: source.id }) })
    assert.equal(response.status, 409)
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    const body = await response.json()
    assert.equal(body.code, "REVISION_TASK_REQUIRED")
    assert.equal(body.revisionTaskId, child.id)
    assert.match(body.error, /请打开该任务后下载/)
    assert.equal(response.headers.get("Content-Disposition"), null)
    const target = await downloadHandler(s)(downloadRequest(s, child.id), { params: Promise.resolve({ id: child.id }) })
    assert.equal((await target.json()).code, "REVISION_NOT_READY")
  } finally { await s.close() }
})

test("AC-01/11：子修订任务提示拒绝跨会话、过期和错误版本，不泄漏目标ID", async () => {
  const { s, source, child, input } = await linkedRevisionTasks()
  try {
    const other = createHash("sha256").update("other task lookup owner").digest("hex")
    const otherSession = await s.sessions.view(other)
    await assert.rejects(s.repository.revisionExport(other, source.id, otherSession.contextId), { status: 404 })
    await assert.rejects(s.repository.revisionExport(s.owner, source.id, randomUUID()), { code: "SESSION_CHANGED" })
    for (const changed of [{ revisionId: randomUUID() }, { revisionHash: "9".repeat(64) }, { documentContextId: randomUUID() }]) {
      await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET input=$1 WHERE id=$2", [JSON.stringify({ ...input, ...changed }), child.id]))
      await assert.rejects(s.repository.revisionExport(s.owner, source.id, s.contextId), { code: "REVISION_NOT_READY", revisionTaskId: undefined })
    }
    await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET input=$1,expires_at=$2 WHERE id=$3", [JSON.stringify(input), "2000-01-01T00:00:00.000Z", child.id]))
    await assert.rejects(s.repository.revisionExport(s.owner, source.id, s.contextId), { code: "REVISION_NOT_READY", revisionTaskId: undefined })
    await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET expires_at=$1 WHERE id=$2", ["2000-01-01T00:00:00.000Z", source.id]))
    const expired = await downloadHandler(s)(downloadRequest(s, source.id), { params: Promise.resolve({ id: source.id }) })
    assert.equal(expired.status, 404)
    assert.equal((await expired.json()).revisionTaskId, undefined)
  } finally { await s.close() }
})

test("AC-01/11：返回子任务ID之前再次鉴权，期间到期不提供跳转提示", async t => {
  const { s, source } = await linkedRevisionTasks()
  try {
    const original = s.sessions.guardIn.bind(s.sessions)
    let guards = 0
    t.mock.method(s.sessions, "guardIn", async (...args: Parameters<typeof original>) => {
      if (++guards === 2) throw new StoreError(410, "资料已到期。", "RETENTION_EXPIRED")
      return original(...args)
    })
    await assert.rejects(s.repository.revisionExport(s.owner, source.id, s.contextId), { code: "RETENTION_EXPIRED" })
    assert.equal(guards, 2)
  } finally { await s.close() }
})

test("AC-01/11：下载HTTP在任务查找后再次核对保留期，过期响应不包含修订任务ID", async t => {
  const { s, source } = await linkedRevisionTasks()
  try {
    const original = s.repository.revisionExport.bind(s.repository)
    const expiration = new Date((await s.sessions.view(s.owner)).expiresAt!)
    t.mock.method(s.repository, "revisionExport", async (...args: Parameters<typeof original>) => {
      try { return await original(...args) }
      catch (failure) { s.setClock(expiration); throw failure }
    })
    const response = await downloadHandler(s)(downloadRequest(s, source.id), { params: Promise.resolve({ id: source.id }) })
    assert.equal(response.status, 410)
    const body = await response.json()
    assert.equal(body.code, "RETENTION_EXPIRED")
    assert.equal(body.revisionTaskId, undefined)
  } finally { await s.close() }
})
