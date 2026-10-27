import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import type { ReviewResult } from "../../../lib/contract-reviews/types"
import { setup } from "./test-fixtures"

test("AC-09/23: a revision-only task is pinned to a completed review and inherits its expiry", async () => {
  const s = await setup()
  try {
    const source = await s.create()
    const job = (await s.repository.claim())!
    assert.equal(job.id, source.id)
    const paragraphs = [{ index: 0, text: "合成合同条款。", inTable: false }]
    const snapshot = { id: randomUUID(), paragraphs, complete: true, textSha256: "a".repeat(64) }
    await s.repository.snapshot(job, snapshot)
    job.snapshot = snapshot
    const result = {
      reviewId: "synthetic", documentTitle: "合成合同", paragraphs, status: "success", errors: [],
      input: { complete: true, textSha256: snapshot.textSha256, parseSnapshotId: snapshot.id, documentVersionId: s.input.revisionId,
        context: s.input.context, title: "合成合同" },
      findings: [{ ruleId: "T-001", category: "付款与结算", kind: "发现问题", severity: "一般关注", risk: "合成问题。",
        quote: paragraphs[0].text, paragraphIndex: 0, basis: [{ sourceId: "S-1" }], checkedParagraphIndexes: [0],
        placeholder: false, pending: [], impact: "", suggestion: "", reviewStatus: "待人工复核" }],
      collaboration: { version: "multi-agent-v1", manifestSha256: "b".repeat(64), phase: "completed", primaryCompleted: true },
    } as unknown as ReviewResult
    await s.repository.finish(job, result, null, 10)
    const pinned = await s.repository.sourceReview(s.owner, source.id, s.contextId)
    assert.equal(pinned.result.status, "success")
    assert.equal(pinned.input.documentId, s.input.documentId)

    const revisionInput = { ...s.input, workflow: "revision-only-v1" as const, generateRevision: true,
      revisionSource: { taskId: source.id, ruleIds: ["T-001"] }, revisionPrimary: pinned.result }
    const revision = await s.repository.create(s.owner, randomUUID(), { ...s.request, generateRevision: true },
      revisionInput, 25, 7, pinned.expiresAt)
    assert.equal(Date.parse(revision.expiresAt) <= Date.parse(pinned.expiresAt), true)

    const other = await setup()
    try {
      await assert.rejects(s.repository.sourceReview(other.owner, source.id, other.contextId))
    } finally { await other.close() }
  } finally { await s.close() }
})
