import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { replayDeletionIntents } from "../../documents/retention-cleanup"
import { setup } from "./test-fixtures"

test("AC-01/23: review tasks enforce context, owner isolation and idempotent submission", async () => {
  const s = await setup()
  try {
    const key = randomUUID()
    const [a, b] = await Promise.all([s.create(key), s.create(key)])
    assert.equal(a.id, b.id)
    assert.equal((await s.repository.list(s.owner, undefined, s.contextId)).length, 1)
    await assert.rejects(s.repository.get(s.owner, a.id, ""), { code: "SESSION_CONTEXT_REQUIRED" })
    await assert.rejects(s.repository.get(s.owner, a.id, randomUUID()), { code: "SESSION_CHANGED" })
    const other = createHash("sha256").update("another synthetic session").digest("hex")
    const otherView = await s.sessions.view(other)
    await assert.rejects(s.repository.get(other, a.id, otherView.contextId), { status: 404 })
    await assert.rejects(s.repository.existing(s.owner, key, { ...s.request, context: { ...s.request.context, region: "北京" } }, s.contextId), { status: 409 })
  } finally { await s.close() }
})

test("AC-23/24: source expiry caps task retention and blocks reads, recovery and sends", async () => {
  const s = await setup()
  try {
    const task = await s.create()
    const view = await s.sessions.view(s.owner)
    assert.equal(task.expiresAt, view.expiresAt)
    const job = (await s.repository.claim())!
    assert.ok(job)
    s.setClock(new Date(view.expiresAt!))
    await assert.rejects(s.repository.get(s.owner, task.id, s.contextId), { code: "RETENTION_EXPIRED" })
    await assert.rejects(s.repository.reserve(job, 1, 10), { code: "RETENTION_EXPIRED" })
    await assert.rejects(s.repository.readRevision(s.owner, task.documentId, task.revisionId, s.contextId), { code: "RETENTION_EXPIRED" })
    await s.repository.release(job)
    await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET lease_until=$1 WHERE id=$2", [new Date(0).toISOString(), task.id]))
    assert.equal(await s.repository.claim(), null)
  } finally { await s.close() }
})

test("AC-01/23: revocation stops an active attempt before the next model call", async () => {
  const s = await setup()
  try {
    const task = await s.create()
    const job = (await s.repository.claim())!
    await s.database.transaction(c => c.query("UPDATE equilens_document_sessions SET revoked_at=$1 WHERE owner=$2", [new Date().toISOString(), s.owner]))
    await assert.rejects(s.repository.reserve(job, 1, 10), { code: "RETENTION_EXPIRED" })
    await assert.rejects(s.repository.action(s.owner, task.id, "retry", s.contextId), { code: "RETENTION_EXPIRED" })
    await assert.rejects(s.repository.list(s.owner, undefined, s.contextId), { code: "RETENTION_EXPIRED" })
  } finally { await s.close() }
})

test("AC-23: legacy export permits existing reports but blocks new processing and retry", async () => {
  const s = await setup()
  try {
    const task = await s.create()
    const job = (await s.repository.claim())!
    await s.database.transaction(c => c.query("UPDATE equilens_document_sessions SET expires_at=$1,export_until=$2 WHERE owner=$3", [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86400000).toISOString(), s.owner]))
    assert.equal((await s.repository.get(s.owner, task.id, s.contextId)).id, task.id)
    await assert.rejects(s.create(), { code: "RETENTION_READ_ONLY" })
    await assert.rejects(s.repository.reserve(job, 1, 10), { code: "RETENTION_READ_ONLY" })
    await assert.rejects(s.repository.action(s.owner, task.id, "retry", s.contextId), { code: "RETENTION_READ_ONLY" })
    assert.equal((await s.repository.action(s.owner, task.id, "cancel", s.contextId)).stage, "cancelled")
  } finally { await s.close() }
})

test("AC-23: recovered attempts retain budgets and reject stale execution tokens", async () => {
  const s = await setup()
  try {
    await s.create()
    const first = (await s.repository.claim())!
    await s.repository.reserve(first, 1, 10)
    await s.repository.release(first)
    await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET lease_until=$1 WHERE id=$2", [new Date(0).toISOString(), first.id]))
    const second = (await s.repository.claim())!
    assert.equal(second.attempt, 2)
    assert.equal(second.callsUsed, 1)
    await assert.rejects(s.repository.reserve(first, 2, 20), { status: 409 })
    await s.repository.reserve(second, 2, 20)
    await assert.rejects(s.repository.reserve(second, 2, 21), { status: 409 })
    await s.repository.finish(second, null, { code: "AI_TIMEOUT", message: "合成超时" }, 30)
    await s.repository.release(second)
    await s.repository.action(s.owner, first.id, "retry", s.contextId)
    const third = (await s.repository.claim())!
    assert.equal(third.callsUsed, 2)
    await s.repository.reserve(third, 3, 40)
    await assert.rejects(s.repository.reserve(third, 4, 50), { status: 409 })
  } finally { await s.close() }
})

test("AC-25: source deletion replay also deletes review tasks and model artifacts", async () => {
  const s = await setup()
  try {
    await s.create()
    const job = (await s.repository.claim())!
    await s.repository.artifact(job, "model-exchange", 1, { synthetic: true })
    const intent = { id: randomUUID(), owner: s.owner, expiresAt: (await s.sessions.view(s.owner)).expiresAt!, requestedAt: new Date().toISOString(), reason: "anonymous-expired" as const }
    await replayDeletionIntents(s.database, { readIntents: async () => [intent], appendIntent: async () => {} })
    await s.database.transaction(async c => {
      assert.equal((await c.query("SELECT id FROM equilens_review_tasks")).rows.length, 0)
      assert.equal((await c.query("SELECT task_id FROM equilens_review_artifacts")).rows.length, 0)
    })
    await assert.rejects(s.repository.reserve(job, 1, 10))
  } finally { await s.close() }
})
