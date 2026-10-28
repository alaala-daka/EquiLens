import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { setup } from "./test-fixtures"

test("AC-09/23: token threshold uses immutable usage before checkpointing and survives another attempt", async () => {
  const s = await setup()
  try {
    const input = { ...s.input, primaryStrategy: "prepared-v1" as const, maxKnownTokens: 10000 }
    await s.repository.create(s.owner, randomUUID(), s.request, input, 25, 7)
    const job = (await s.repository.claim())!
    await s.repository.reserve(job, 1, 1)
    await s.repository.artifact(job, "model-exchange", 1, { response: { choices: [{ finish_reason: "length" }], usage: { prompt_tokens: 2000, completion_tokens: 8000, total_tokens: 10000 } } })
    assert.equal((await s.repository.get(s.owner, job.id, s.contextId)).result, null)
    await assert.rejects(s.repository.reserve(job, 2, 2), { code: "REVIEW_TOKEN_BUDGET_EXHAUSTED" })
    assert.equal((await s.repository.get(s.owner, job.id, s.contextId)).callsUsed, 1)
    await s.repository.finish(job, null, { code: "AI_OUTPUT_TRUNCATED", message: "合成截断" }, 3)
    await s.repository.release(job)
    await s.repository.action(s.owner, job.id, "retry", s.contextId)
    const next = (await s.repository.claim())!
    assert.equal(next.callsUsed, 1)
    assert.equal(next.input.maxKnownTokens, 10000)
    await assert.rejects(s.repository.reserve(next, 2, 4), { code: "REVIEW_TOKEN_BUDGET_EXHAUSTED" })
    await s.repository.finish(next, null, { code: "REVIEW_TOKEN_BUDGET_EXHAUSTED", message: "合成停止阈值" }, 5)
    await assert.rejects(s.repository.action(s.owner, next.id, "retry", s.contextId), { status: 409 })
  } finally { await s.close() }
})

test("AC-23: cache hits count toward token threshold, missing usage retains the request limit and old tasks stay unchanged", async () => {
  const s = await setup()
  try {
    await s.repository.create(s.owner, randomUUID(), s.request, { ...s.input, maxKnownTokens: 10000 }, 3, 7)
    const job = (await s.repository.claim())!
    await s.repository.reserve(job, 1, 1)
    await s.repository.artifact(job, "model-exchange", 1, { response: {} })
    await s.repository.reserve(job, 2, 2)
    await s.repository.artifact(job, "model-exchange", 2, { response: { usage: { total_tokens: 10000, prompt_tokens_details: { cached_tokens: 9999 } } } })
    await assert.rejects(s.repository.reserve(job, 3, 3), { code: "REVIEW_TOKEN_BUDGET_EXHAUSTED" })
    await s.repository.finish(job, null, { code: "REVIEW_TOKEN_BUDGET_EXHAUSTED", message: "合成停止" }, 4)
    await s.repository.release(job)
    await s.create()
    const old = (await s.repository.claim())!
    await s.repository.reserve(old, 1, 1)
    await s.repository.artifact(old, "model-exchange", 1, { response: { usage: { total_tokens: 999999 } } })
    await s.repository.reserve(old, 2, 2)
    assert.equal(old.input.primaryStrategy, undefined)
  } finally { await s.close() }
})

test("AC-23: summary retention omits full exchange; full retention double-writes without double-counting the same call", async () => {
  const s = await setup()
  try {
    const create = (retention: "summary" | "full") => s.repository.create(s.owner, randomUUID(), s.request,
      { ...s.input, exchangeRetention: retention, maxKnownTokens: 10000 }, 5, 7)
    await create("summary")
    const summaryJob = (await s.repository.claim())!
    await s.repository.reserve(summaryJob, 1, 1)
    await s.repository.artifact(summaryJob, "model-exchange", 1, { response: { usage: { prompt_tokens: 6000, completion_tokens: 3000, total_tokens: 9000 } } })
    await s.repository.reserve(summaryJob, 2, 2)
    const summaryStages = (await s.database.transaction(c => c.query("SELECT stage,COUNT(*) AS count FROM equilens_review_artifacts WHERE task_id=$1 GROUP BY stage", [summaryJob.id]))).rows
    assert.deepEqual(summaryStages.map(row => [String(row.stage), Number(row.count)]), [["model-summary", 1]])
    await s.repository.finish(summaryJob, null, { code: "REVIEW_BUDGET_EXHAUSTED", message: "合成停止" }, 3)
    await s.repository.release(summaryJob)

    await create("full")
    const fullJob = (await s.repository.claim())!
    await s.repository.reserve(fullJob, 1, 1)
    await s.repository.artifact(fullJob, "model-exchange", 1, { response: { usage: { prompt_tokens: 6000, completion_tokens: 3000, total_tokens: 9000 } } })
    // 同一调用的摘要与全文不能重复计入；第二次预留在 9,000 时仍应通过。
    await s.repository.reserve(fullJob, 2, 2)
    const fullStages = (await s.database.transaction(c => c.query("SELECT stage,COUNT(*) AS count FROM equilens_review_artifacts WHERE task_id=$1 GROUP BY stage", [fullJob.id]))).rows
    assert.deepEqual(fullStages.map(row => [String(row.stage), Number(row.count)]), [["model-exchange", 1], ["model-summary", 1]])
  } finally { await s.close() }
})
