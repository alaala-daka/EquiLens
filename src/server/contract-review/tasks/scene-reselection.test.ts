import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { setup } from "./test-fixtures"
import { submitReviewSchema } from "./schema"

test("AC-01/21/23: scene reselection creates a separate pinned task, checks source ownership/state/version", async () => {
  const s = await setup()
  try {
    const original = await s.create()
    await assert.rejects(s.repository.sceneReselectionSource(s.owner, original.id, s.contextId, s.request.documentId, s.request.revisionId), { status: 409 })
    await s.database.transaction(c => c.query("UPDATE equilens_review_tasks SET state='failed',stage='failed',error_code='REVIEW_SCENE_UNCERTAIN' WHERE id=$1", [original.id]))
    const source = await s.repository.sceneReselectionSource(s.owner, original.id, s.contextId, s.request.documentId, s.request.revisionId)
    await assert.rejects(s.repository.sceneReselectionSource("f".repeat(64), original.id, s.contextId, s.request.documentId, s.request.revisionId))
    await assert.rejects(s.repository.sceneReselectionSource(s.owner, original.id, s.contextId, s.request.documentId, randomUUID()), { status: 409 })
    const request = { ...s.request, context: { ...s.request.context, scene: "mep-sub-2026" as const }, sceneSource: "user" as const, sceneSourceTaskId: original.id, sceneReason: "确认本次为机电安装专业分包。" }
    assert.equal(submitReviewSchema.safeParse(request).success, true)
    assert.equal(submitReviewSchema.safeParse({ ...request, sceneReason: "" }).success, false)
    assert.equal(submitReviewSchema.safeParse({ ...request, context: { ...request.context, scene: "auto" } }).success, false)
    const selectedAt = new Date().toISOString()
    const fresh = await s.repository.create(s.owner, randomUUID(), request, { ...s.input, ...request, sceneSelectedAt: selectedAt }, 3, 7, source.expiresAt)
    assert.notEqual(fresh.id, original.id)
    assert.deepEqual(fresh.sceneReselection, { scene: "mep-sub-2026", sourceTaskId: original.id, reason: request.sceneReason, selectedAt })
    assert.equal((await s.repository.get(s.owner, original.id, s.contextId)).error?.code, "REVIEW_SCENE_UNCERTAIN")
  } finally { await s.close() }
})
