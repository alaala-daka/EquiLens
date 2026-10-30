import assert from "node:assert/strict"
import { test } from "node:test"
import type { Connection } from "../database/connection"
import { TaskError } from "./errors"
import type { CallBudgetEstimate, ClaimedTask, TaskBudgetReservation } from "./repository"
import { setupTasks, ref, reviewConditions, reviewRequest, validRequest } from "./test-fixtures"

async function rejectsTask(work: Promise<unknown>, status: number, code: string) {
  await assert.rejects(work, (failure: unknown) => {
    assert.ok(failure instanceof TaskError, `expected TaskError, received ${String(failure)}`)
    assert.equal(failure.status, status)
    assert.equal(failure.code, code)
    return true
  })
}

function clockOf(start = "2026-10-28T00:00:00.000Z") {
  let value = Date.parse(start)
  return { now: () => new Date(value), advance: (ms: number) => { value += ms } }
}

test("A3a: submit persists a queued task before any claim and claims it once", async () => {
  const s = await setupTasks()
  try {
    const submitted = await s.repository.submit("account-1", "operation-1", validRequest("contract-review"))
    assert.equal(submitted.created, true)
    assert.equal(submitted.task.state, "queued")
    assert.equal(submitted.task.projectId, "project-1")
    const raw = await s.database.transaction(connection => connection.query("SELECT state,attempt,execution_token FROM equilens_tasks WHERE id=$1", [submitted.task.id]))
    assert.equal(raw.rows[0].state, "queued")
    assert.equal(Number(raw.rows[0].attempt), 0)
    assert.equal(raw.rows[0].execution_token, null, "persisted before execution starts")

    const claimed = await s.repository.claimNext()
    assert.ok(claimed)
    assert.equal(claimed.id, submitted.task.id)
    assert.equal(claimed.attempt, 1)
    assert.ok(claimed.token)
    const running = await s.repository.get("account-1", submitted.task.id)
    assert.equal(running.state, "running")
    assert.equal(running.attempt, 1)
  } finally { await s.close() }
})

test("A3a/AC-23: same operationId and input returns the original task; changed input conflicts", async () => {
  const s = await setupTasks()
  try {
    const first = await s.repository.submit("account-1", "operation-idem", validRequest("contract-review"))
    const second = await s.repository.submit("account-1", "operation-idem", validRequest("contract-review"))
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.task.id, first.task.id)
    assert.equal((await s.repository.list("account-1")).length, 1)

    const changed = { ...reviewRequest(), conditions: { ...reviewConditions, asOf: "2026-10-29" } }
    await rejectsTask(s.repository.submit("account-1", "operation-idem", changed), 409, "CONFLICT")
    const unchanged = await s.repository.get("account-1", first.task.id)
    assert.equal(unchanged.state, "queued")
    assert.equal(unchanged.manifest.conditions.asOf, undefined)

    // Idempotency survives the terminal state; a repeat never re-creates a paid task.
    const claimed = await s.repository.claimNext()
    assert.ok(claimed)
    await s.repository.finish(claimed, { state: "success" })
    const repeated = await s.repository.submit("account-1", "operation-idem", validRequest("contract-review"))
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, first.task.id)
    assert.equal(repeated.task.state, "success")
  } finally { await s.close() }
})

test("A3a: operationId is scoped per account and project, not global", async () => {
  const s = await setupTasks()
  try {
    const first = await s.repository.submit("account-1", "operation-shared", validRequest("document-analysis"))
    const otherProject = {
      kind: "document-analysis" as const, projectId: "project-2",
      refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }] }, conditions: { externalProcessingConsent: true },
    }
    const second = await s.repository.submit("account-1", "operation-shared", otherProject)
    assert.equal(first.created, true)
    assert.equal(second.created, true)
    assert.notEqual(first.task.id, second.task.id)
    // A repeat in the same project still returns the original task.
    const repeat = await s.repository.submit("account-1", "operation-shared", validRequest("document-analysis"))
    assert.equal(repeat.created, false)
    assert.equal(repeat.task.id, first.task.id)
    // Another account is never treated as the same submitter.
    const other = await s.repository.submit("account-2", "operation-shared", validRequest("document-analysis"))
    assert.equal(other.created, true)
    assert.notEqual(other.task.id, first.task.id)
    assert.equal((await s.repository.list("account-1")).length, 2)
    assert.equal((await s.repository.list("account-2")).length, 1)
  } finally { await s.close() }
})

test("A3a: the third unfinished task for one account is rejected", async () => {
  const s = await setupTasks()
  try {
    await s.repository.submit("account-1", "operation-0001", validRequest("contract-review"))
    await s.repository.submit("account-1", "operation-0002", validRequest("document-analysis"))
    await rejectsTask(s.repository.submit("account-1", "operation-0003", validRequest("evidence-organization")), 429, "LIMIT_EXCEEDED")
    // Other accounts keep their own allowance.
    const other = await s.repository.submit("account-2", "operation-0001", validRequest("contract-review"))
    assert.equal(other.created, true)
  } finally { await s.close() }
})

test("A3a: per-account admission holds under concurrent submissions", async () => {
  const s = await setupTasks()
  try {
    const results = await Promise.allSettled(["operation-a", "operation-b", "operation-c"].map(operationId =>
      s.repository.submit("account-1", operationId, validRequest("document-analysis"))))
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2)
    const rejected = results.filter(result => result.status === "rejected")
    assert.equal(rejected.length, 1)
    for (const result of rejected) {
      assert.ok(result.status === "rejected" && result.reason instanceof TaskError && result.reason.code === "LIMIT_EXCEEDED")
    }
    assert.equal((await s.repository.list("account-1")).length, 2)
  } finally { await s.close() }
})

test("A3a: the 11th queued task is rejected and finishing one frees the queue slot", async () => {
  const s = await setupTasks()
  try {
    for (let owner = 1; owner <= 5; owner++) {
      await s.repository.submit(`account-${owner}`, `operation-${owner}a`, validRequest("contract-review"))
      await s.repository.submit(`account-${owner}`, `operation-${owner}b`, validRequest("document-analysis"))
    }
    await rejectsTask(s.repository.submit("account-6", "operation-6a", validRequest("contract-review")), 429, "LIMIT_EXCEEDED")

    const claimed = await s.repository.claimNext()
    assert.ok(claimed)
    await s.repository.finish(claimed, { state: "success" })
    const admitted = await s.repository.submit("account-6", "operation-6a", validRequest("contract-review"))
    assert.equal(admitted.created, true)
  } finally { await s.close() }
})

test("A3a: queue admission never exceeds 10 under concurrent competition", async () => {
  const s = await setupTasks()
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      s.repository.submit(`account-${index}`, `operation-${index}`, validRequest("document-analysis"))))
    assert.equal(results.filter(result => result.status === "fulfilled").length, 10)
    const rejected = results.filter(result => result.status === "rejected")
    assert.equal(rejected.length, 2)
    for (const result of rejected) {
      assert.ok(result.status === "rejected" && result.reason instanceof TaskError && result.reason.code === "LIMIT_EXCEEDED")
    }
    const rows = await s.database.transaction(connection => connection.query("SELECT COUNT(*) AS total FROM equilens_tasks WHERE state='queued'"))
    assert.equal(Number(rows.rows[0].total), 10)
  } finally { await s.close() }
})

test("A3a: one global execution lease prevents a second claim until the task finishes", async () => {
  const s = await setupTasks()
  try {
    await s.repository.submit("account-1", "operation-one", validRequest("contract-review"))
    await s.repository.submit("account-2", "operation-two", validRequest("document-analysis"))
    const first = await s.repository.claimNext()
    assert.ok(first)
    assert.equal(await s.repository.claimNext(), null, "one global execution slot")
    await s.repository.heartbeat(first, 1000)
    await s.repository.finish(first, { state: "success", resultSummary: "完成" })
    const second = await s.repository.claimNext()
    assert.ok(second)
    assert.notEqual(second.id, first.id)
  } finally { await s.close() }
})

test("A3a/AC-23: expired leases recover as a new attempt and the old token can never write", async () => {
  const clock = clockOf()
  const s = await setupTasks({ now: clock.now })
  try {
    const submitted = await s.repository.submit("account-1", "operation-recover", validRequest("contract-review"))
    const first = await s.repository.claimNext()
    assert.ok(first)
    clock.advance(61_000)
    const second = await s.repository.claimNext()
    assert.ok(second)
    assert.equal(second.id, first.id)
    assert.equal(second.attempt, 2)
    assert.notEqual(second.token, first.token)

    await rejectsTask(s.repository.heartbeat(first, 1000), 409, "CONFLICT")
    await rejectsTask(s.repository.finish(first, { state: "success" }), 409, "CONFLICT")
    await s.repository.heartbeat(second, 120_000)
    await s.repository.finish(second, { state: "partial", resultSummary: "部分完成" })
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "partial")
    assert.equal(view.resultSummary, "部分完成")
    assert.equal(view.attempt, 2)
  } finally { await s.close() }
})

test("A3a: heartbeat after the lease expired is rejected", async () => {
  const clock = clockOf()
  const s = await setupTasks({ now: clock.now })
  try {
    await s.repository.submit("account-1", "operation-heartbeat", validRequest("document-analysis"))
    const job = await s.repository.claimNext()
    assert.ok(job)
    clock.advance(61_000)
    await rejectsTask(s.repository.heartbeat(job, 1000), 409, "CONFLICT")
    await rejectsTask(s.repository.finish(job, { state: "success" }), 409, "CONFLICT")
  } finally { await s.close() }
})

test("A3a: attempts are bounded and exhaustion ends the task, not the queue loop", async () => {
  const clock = clockOf()
  const s = await setupTasks({ now: clock.now })
  try {
    const submitted = await s.repository.submit("account-1", "operation-attempts", validRequest("document-analysis"))
    const first = await s.repository.claimNext()
    assert.ok(first)
    assert.equal(first.attempt, 1)
    for (const attempt of [2, 3]) {
      clock.advance(61_000)
      const next = await s.repository.claimNext()
      assert.equal(next?.attempt, attempt)
    }
    clock.advance(61_000)
    assert.equal(await s.repository.claimNext(), null)
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "failed")
    assert.equal(view.error?.code, "TASK_ATTEMPT_EXHAUSTED")
  } finally { await s.close() }
})

test("A3a: recovery tolerates a running row whose lease was never persisted", async () => {
  const clock = clockOf()
  const s = await setupTasks({ now: clock.now })
  try {
    const submitted = await s.repository.submit("account-1", "operation-null-lease", validRequest("document-analysis"))
    const first = await s.repository.claimNext()
    assert.ok(first)
    // Simulate a crash between the running write and the lease timestamp.
    await s.database.transaction(connection => connection.query(
      "UPDATE equilens_tasks SET lease_until=NULL,elapsed_ms=0 WHERE id=$1", [submitted.task.id]))
    clock.advance(61_000)
    const recovered = await s.repository.claimNext()
    assert.ok(recovered)
    assert.equal(recovered.id, submitted.task.id)
    assert.equal(recovered.attempt, 2)
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "running")
    assert.equal(Number.isFinite(view.elapsedMs), true, "elapsed time must stay a finite number")
  } finally { await s.close() }
})

class FakeBudget implements TaskBudgetReservation {
  readonly reservations: { callNumber: number; callsUsedBefore: number; estimate: CallBudgetEstimate }[] = []
  fail = false
  async reserve(connection: Connection, job: ClaimedTask, callNumber: number, estimate: CallBudgetEstimate) {
    if (this.fail) throw new TaskError(429, "BUDGET_EXHAUSTED", "任务预算不足。")
    const row = (await connection.query("SELECT calls_used FROM equilens_tasks WHERE id=$1", [job.id])).rows[0]
    this.reservations.push({ callNumber, callsUsedBefore: Number(row.calls_used), estimate })
  }
}

test("A3a/A3b seam: budget reservation runs before the call counter and a failure rolls it back", async () => {
  const budget = new FakeBudget()
  const s = await setupTasks({ budget })
  const estimate = { costFen: 100, timeMs: 1000 }
  try {
    const submitted = await s.repository.submit("account-1", "operation-budget", validRequest("contract-review"))
    const job = await s.repository.claimNext()
    assert.ok(job)
    await s.repository.reserveCall(job, 1, 0, estimate)
    assert.deepEqual(budget.reservations, [{ callNumber: 1, callsUsedBefore: 0, estimate }])
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 1)

    // Wrong call order is rejected without a second reservation.
    await rejectsTask(s.repository.reserveCall(job, 3, 0, estimate), 409, "CONFLICT")
    assert.equal(budget.reservations.length, 1)
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 1)

    // A budget failure aborts the transaction: no counted call, no external request.
    budget.fail = true
    await rejectsTask(s.repository.reserveCall(job, 2, 10, estimate), 429, "BUDGET_EXHAUSTED")
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 1)
    budget.fail = false
    await s.repository.reserveCall(job, 2, 10, estimate)
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 2)
  } finally { await s.close() }
})

test("A3a: kinds without paid calls never reserve a model call", async () => {
  const s = await setupTasks()
  try {
    await s.repository.submit("account-1", "operation-parse", validRequest("material-parse"))
    const job = await s.repository.claimNext()
    assert.ok(job)
    assert.equal(job.maxCalls, 0)
    await rejectsTask(s.repository.reserveCall(job, 1, 0, { costFen: 10, timeMs: 100 }), 409, "CONFLICT")
  } finally { await s.close() }
})

test("A3a: reads are owner-scoped and can be filtered by project", async () => {
  const s = await setupTasks()
  try {
    await s.repository.submit("account-1", "operation-project-1", validRequest("contract-review"))
    await s.repository.submit("account-1", "operation-project-2", reviewRequest("project-2"))
    assert.equal((await s.repository.list("account-1")).length, 2)
    assert.equal((await s.repository.list("account-1", "project-1")).length, 1)
    assert.equal((await s.repository.list("account-1", "project-2")).length, 1)
    assert.equal((await s.repository.list("account-2")).length, 0)
    await rejectsTask(s.repository.get("account-2", (await s.repository.list("account-1"))[0].id), 404, "NOT_FOUND")
  } finally { await s.close() }
})

test("A3a: a tampered stored manifest fails the task instead of executing altered input", async () => {
  const s = await setupTasks()
  try {
    const submitted = await s.repository.submit("account-1", "operation-tamper", validRequest("contract-review"))
    await s.database.transaction(connection => connection.query("UPDATE equilens_tasks SET manifest=$1 WHERE id=$2", [JSON.stringify({ tampered: true }), submitted.task.id]))
    assert.equal(await s.repository.claimNext(), null)
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "failed")
    assert.equal(view.error?.code, "TASK_INPUT_INVALID")
  } finally { await s.close() }
})

test("A3a: terminal states reject further lease writes and hold no execution slot", async () => {
  const s = await setupTasks()
  try {
    await s.repository.submit("account-1", "operation-terminal", validRequest("document-analysis"))
    const job = await s.repository.claimNext()
    assert.ok(job)
    const finished = await s.repository.finish(job, { state: "failed", errorCode: "REVIEW_FAILED", errorMessage: "模型调用失败。" })
    assert.equal(finished.state, "failed")
    assert.equal(finished.error?.code, "REVIEW_FAILED")
    await rejectsTask(s.repository.finish(job, { state: "success" }), 409, "CONFLICT")
    assert.equal(await s.repository.claimNext(), null)
  } finally { await s.close() }
})
