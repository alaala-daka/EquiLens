import assert from "node:assert/strict"
import { test } from "node:test"
import { MAX_BUDGET_AMOUNT, TaskBudgetRepository } from "./budget"
import { TaskError } from "./errors"
import type { CallBudgetEstimate, ClaimedTask } from "./repository"
import { setupTasks, validRequest, type TaskTestOptions } from "./test-fixtures"

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

async function setupBudget() {
  const clock = clockOf()
  let budget!: TaskBudgetRepository
  const tasks = await setupTasks({
    now: clock.now,
    budgetFactory: database => (budget = new TaskBudgetRepository(database, { now: clock.now })),
  })
  return {
    get database() { return tasks.database },
    get repository() { return tasks.repository },
    get budget() { return budget },
    clock,
    path: tasks.path,
    reopen: (options?: TaskTestOptions) => tasks.reopen(options),
    close: () => tasks.close(),
  }
}

async function startTask(s: Awaited<ReturnType<typeof setupBudget>>, kind: "document-analysis" | "contract-review" = "document-analysis", operationId = "operation-budget") {
  const submitted = await s.repository.submit("account-1", operationId, validRequest(kind))
  const job = await s.repository.claimNext()
  assert.ok(job)
  return { submitted, job }
}

const estimate = (costFen = 100, timeMs = 1000): CallBudgetEstimate => ({ costFen, timeMs })

test("A3b: an unregistered project budget refuses paid calls before the external request", async () => {
  const s = await setupBudget()
  let external = 0
  try {
    const { submitted, job } = await startTask(s)
    // The reserved call is the only path to the external request.
    const callExternal = async () => {
      await s.repository.reserveCall(job, 1, 0, estimate())
      external++
    }
    await rejectsTask(callExternal(), 409, "BUDGET_EXHAUSTED")
    assert.equal(external, 0, "no external request after a refused reservation")
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 0)
    const taskBudget = await s.budget.taskBudget(submitted.task.id)
    assert.ok(taskBudget)
    assert.equal(taskBudget.costReservedFen, 0)
    assert.equal(await s.budget.projectBudget("project-1"), null)
  } finally { await s.close() }
})

test("A3b: a paid kind without any budget gate is refused instead of running unbudgeted", async () => {
  const s = await setupTasks()
  try {
    const submitted = await s.repository.submit("account-1", "operation-no-gate", validRequest("document-analysis"))
    const job = await s.repository.claimNext()
    assert.ok(job)
    await rejectsTask(s.repository.reserveCall(job, 1, 0, estimate()), 409, "BUDGET_EXHAUSTED")
    assert.equal((await s.repository.get("account-1", submitted.task.id)).callsUsed, 0)
  } finally { await s.close() }
})

test("A3b: call, time, task cost and project cost reserve atomically and re-reserving is idempotent", async () => {
  const s = await setupBudget()
  try {
    const registered = await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    assert.equal(registered.costLimitFen, 1000)
    assert.equal(registered.remainingFen, 1000)
    const { submitted, job } = await startTask(s)
    const call = estimate(100, 1000)
    let external = 0
    await s.repository.reserveCall(job, 1, 0, call)
    external++
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.deepEqual(
      { reserved: task.costReservedFen, charged: task.costChargedFen, time: task.timeReservedMs, calls: task.callsUsed },
      { reserved: 100, charged: 0, time: 1000, calls: 1 },
    )
    assert.deepEqual(
      { reserved: project.costReservedFen, charged: project.costChargedFen, remaining: project.remainingFen },
      { reserved: 100, charged: 0, remaining: 900 },
    )

    // A lost response can repeat the same attempt/call: no double charge.
    await s.database.transaction(connection => s.budget.reserve(connection, job, 1, call))
    const again = await s.budget.taskBudget(submitted.task.id)
    const projectAgain = await s.budget.projectBudget("project-1")
    assert.ok(again && projectAgain)
    assert.equal(again.costReservedFen, 100)
    assert.equal(projectAgain.costReservedFen, 100)
    // A different estimate for the same call is a conflict, not a silent change.
    await assert.rejects(
      s.database.transaction(connection => s.budget.reserve(connection, job, 1, estimate(101, 1000))),
      (failure: unknown) => failure instanceof TaskError && failure.code === "CONFLICT",
    )
    assert.equal(external, 1)
  } finally { await s.close() }
})

test("A3b: known usage settles exactly, unknown usage keeps the conservative reservation", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(100, 1000))
    const known = await s.budget.settle(job, 1, { costFen: 70, timeMs: 800 })
    assert.deepEqual(known, { costFen: 70, timeMs: 800, unknown: false })
    const afterKnown = await s.budget.taskBudget(submitted.task.id)
    assert.ok(afterKnown)
    assert.equal(afterKnown.costReservedFen, 0)
    assert.equal(afterKnown.costChargedFen, 70)
    assert.equal(afterKnown.timeChargedMs, 800)

    await s.repository.reserveCall(job, 2, 5000, estimate(150, 2000))
    const unknown = await s.budget.recordUnknownUsage(job, 2)
    assert.deepEqual(unknown, { costFen: 150, timeMs: 2000, unknown: true })
    const afterUnknown = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(afterUnknown && project)
    assert.equal(afterUnknown.costReservedFen, 0)
    assert.equal(afterUnknown.costChargedFen, 220, "unknown usage stays charged at the reserved amount")
    assert.equal(afterUnknown.timeChargedMs, 2800)
    assert.equal(project.costChargedFen, 220)
    // Settling twice is idempotent and keeps the conservative result.
    assert.deepEqual(await s.budget.recordUnknownUsage(job, 2), unknown)
  } finally { await s.close() }
})

test("A3b: task cost budget is enforced separately from the project budget", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 5000, "operator-1")
    const { submitted, job } = await startTask(s)
    let external = 0
    await s.repository.reserveCall(job, 1, 0, estimate(200, 1000)) // document-analysis task ceiling is 300 fen
    external++
    await rejectsTask(s.repository.reserveCall(job, 2, 5000, estimate(200, 1000)), 409, "BUDGET_EXHAUSTED")
    assert.equal(external, 1)
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.equal(task.callsUsed, 1)
    assert.equal(task.costReservedFen, 200)
    assert.equal(project.costReservedFen, 200, "the project still has room; only the task ceiling stopped the call")
  } finally { await s.close() }
})

test("A3b: task time budget is reserved and enforced before the call", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 5000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(10, 400000))
    await rejectsTask(s.repository.reserveCall(job, 2, 5000, estimate(10, 300000)), 409, "BUDGET_EXHAUSTED")
    const task = await s.budget.taskBudget(submitted.task.id)
    assert.ok(task)
    assert.equal(task.callsUsed, 1)
    assert.equal(task.timeReservedMs, 400000)
  } finally { await s.close() }
})

test("A3b: the project cost budget admits the first call and refuses the next before any external request", async () => {
  const s = await setupBudget()
  let external = 0
  try {
    await s.budget.registerProjectBudget("project-1", 150, "operator-1")
    const { submitted, job } = await startTask(s, "contract-review")
    await s.repository.reserveCall(job, 1, 0, estimate(100, 1000))
    external++
    await rejectsTask(s.repository.reserveCall(job, 2, 5000, estimate(100, 1000)), 409, "BUDGET_EXHAUSTED")
    const project = await s.budget.projectBudget("project-1")
    const task = await s.budget.taskBudget(submitted.task.id)
    assert.ok(project && task)
    assert.equal(external, 1)
    assert.equal(project.costReservedFen, 100)
    assert.equal(task.callsUsed, 1)
    assert.equal(task.costReservedFen, 100)
  } finally { await s.close() }
})

test("A3b/AC-23: a reservation that survives a crash is not reset, and the stale attempt cannot settle or double-charge", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(200, 2000))
    // Crash before the provider response; the conservative reservation persists.
    const afterCrash = await s.budget.taskBudget(submitted.task.id)
    assert.ok(afterCrash)
    assert.equal(afterCrash.costReservedFen, 200)

    s.clock.advance(61_000)
    const recovered = await s.repository.claimNext()
    assert.ok(recovered)
    assert.equal(recovered.id, job.id)
    assert.equal(recovered.attempt, 2)
    const persisted = await s.budget.taskBudget(submitted.task.id)
    assert.ok(persisted)
    assert.equal(persisted.costReservedFen, 200, "recovery does not clear the reservation")
    assert.equal(persisted.timeReservedMs, 2000)
    assert.equal(persisted.callsUsed, 1, "recovery does not reset the call counter")

    // The old attempt's token is fenced off.
    await rejectsTask(s.budget.settle(job, 1, { costFen: 50, timeMs: 500 }), 409, "CONFLICT")
    await rejectsTask(s.budget.settleOutstanding(job), 409, "CONFLICT")

    // The recovered attempt keeps spending against the same persisted budget.
    await s.repository.reserveCall(recovered, 2, 70000, estimate(100, 1000))
    const settled = await s.budget.settle(recovered, 2, { costFen: 80, timeMs: 900 })
    assert.deepEqual(settled, { costFen: 80, timeMs: 900, unknown: false })
    const beforeFinish = await s.budget.taskBudget(submitted.task.id)
    assert.ok(beforeFinish)
    assert.equal(beforeFinish.costReservedFen, 200, "the crashed call is still conservatively reserved")
    assert.equal(beforeFinish.costChargedFen, 80)

    // Terminal conservative settlement charges the crashed call at its reserved amount once.
    assert.deepEqual(await s.budget.settleOutstanding(recovered), { settled: 1 })
    assert.deepEqual(await s.budget.settleOutstanding(recovered), { settled: 0 })
    const finished = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(finished && project)
    assert.equal(finished.costReservedFen, 0)
    assert.equal(finished.costChargedFen, 280, "80 known + 200 conservative; no duplicate charge")
    assert.equal(finished.timeChargedMs, 2900)
    assert.equal(project.costReservedFen, 0)
    assert.equal(project.costChargedFen, 280)
    await s.repository.finish(recovered, { state: "partial", resultSummary: "部分完成" })
  } finally { await s.close() }
})

test("A3b/AC-12: a process restart keeps reservations, call count and remaining budget", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(200, 2000))
    // Process exits before the provider response or settlement.
    s.clock.advance(61_000)
    await s.reopen()

    // A fresh process/repository still sees the committed reservation and call.
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.equal(task.costReservedFen, 200)
    assert.equal(task.timeReservedMs, 2000)
    assert.equal(task.callsUsed, 1)
    assert.equal(project.costReservedFen, 200)

    const recovered = await s.repository.claimNext()
    assert.ok(recovered)
    assert.equal(recovered.attempt, 2)
    // The attempt from before the restart cannot settle the reservation.
    await rejectsTask(s.budget.settle(job, 1, {}), 409, "CONFLICT")
    // Remaining budget is enforced against the persisted reservation.
    await rejectsTask(s.repository.reserveCall(recovered, 2, 70000, estimate(200, 1000)), 409, "BUDGET_EXHAUSTED")
    await s.repository.reserveCall(recovered, 2, 70000, estimate(100, 1000))

    // Terminal conservative cleanup charges the crashed reservation exactly once.
    assert.deepEqual(await s.budget.settleOutstanding(recovered), { settled: 2 })
    const final = await s.budget.taskBudget(submitted.task.id)
    const finalProject = await s.budget.projectBudget("project-1")
    assert.ok(final && finalProject)
    assert.equal(final.costReservedFen, 0)
    assert.equal(final.costChargedFen, 300)
    assert.equal(final.callsUsed, 2)
    assert.equal(finalProject.costReservedFen, 0)
    assert.equal(finalProject.costChargedFen, 300)
    await s.repository.finish(recovered, { state: "failed", errorCode: "TASK_FAILED", errorMessage: "任务失败。" })
  } finally { await s.close() }
})

test("A3b: a refused reservation rolls the transaction back and leaves no partial budget state", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 300, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(200, 1000))
    await rejectsTask(s.repository.reserveCall(job, 2, 5000, estimate(200, 1000)), 409, "BUDGET_EXHAUSTED")
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    const reservations = await s.database.transaction(connection =>
      connection.query("SELECT COUNT(*) AS total FROM equilens_task_budget_reservations WHERE task_id=$1", [submitted.task.id]))
    assert.ok(task && project)
    assert.equal(task.callsUsed, 1)
    assert.equal(task.costReservedFen, 200)
    assert.equal(project.costReservedFen, 200)
    assert.equal(Number(reservations.rows[0].total), 1)
  } finally { await s.close() }
})

test("A3b: concurrent reservations against one project budget never exceed the limit", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 300, "operator-1")
    const first = await s.repository.submit("account-1", "operation-concurrent-a", validRequest("document-analysis"))
    const second = await s.repository.submit("account-1", "operation-concurrent-b", validRequest("document-analysis"))
    const jobA = await s.repository.claimNext()
    assert.ok(jobA)
    // Simulate a second live attempt for the concurrency test (global execution
    // is one, but two ledger reservations must still not overshoot the budget).
    // Claim order is by created_at/id, so fabricate whichever task was not claimed.
    const other = jobA.id === first.task.id ? second : first
    const secondView = await s.repository.get("account-1", other.task.id)
    const tokenB = "token-b"
    const leaseUntil = new Date(s.clock.now().getTime() + 60_000).toISOString()
    const now = s.clock.now().toISOString()
    await s.database.transaction(connection => connection.query(
      "UPDATE equilens_tasks SET state='running',attempt=1,execution_token=$1,lease_until=$2,attempt_started_at=$3,updated_at=$4 WHERE id=$5",
      [tokenB, leaseUntil, now, now, secondView.id],
    ))
    const jobB: ClaimedTask = {
      id: secondView.id, owner: "account-1", projectId: "project-1", kind: "document-analysis",
      token: tokenB, attempt: 1, callsUsed: 0, maxCalls: 3, elapsedMs: 0, startedAt: now, manifest: secondView.manifest,
    }
    const results = await Promise.allSettled([
      s.repository.reserveCall(jobA, 1, 0, estimate(200, 1000)),
      s.repository.reserveCall(jobB, 1, 0, estimate(200, 1000)),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const rejected = results.filter(result => result.status === "rejected")
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof TaskError && rejected[0].reason.code === "BUDGET_EXHAUSTED")
    const project = await s.budget.projectBudget("project-1")
    assert.ok(project)
    assert.equal(project.costReservedFen, 200, "the ledger holds exactly the admitted reservation")
    assert.equal(project.remainingFen, 100)
    const rows = await s.database.transaction(connection => connection.query("SELECT COUNT(*) AS total FROM equilens_task_budget_reservations WHERE project_id=$1", ["project-1"]))
    assert.equal(Number(rows.rows[0].total), 1)
  } finally { await s.close() }
})

test("A3b: project budget registration rejects invalid or lowering amounts and records overages without clamping", async () => {
  const s = await setupBudget()
  try {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejectsTask(s.budget.registerProjectBudget("project-1", invalid, "operator-1"), 422, "INVALID_SUBMISSION")
    }
    await rejectsTask(s.budget.registerProjectBudget("", 100, "operator-1"), 422, "INVALID_SUBMISSION")
    // The schema stores registered_by as VARCHAR(36): an overlong actor is rejected up front.
    await rejectsTask(s.budget.registerProjectBudget("project-1", 100, "x".repeat(37)), 422, "INVALID_SUBMISSION")
    await s.budget.registerProjectBudget("project-1", 500, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(80, 1000))
    await rejectsTask(s.budget.registerProjectBudget("project-1", 50, "operator-1"), 409, "CONFLICT")
    const raised = await s.budget.registerProjectBudget("project-1", 600, "operator-1")
    assert.equal(raised.costLimitFen, 600)

    // A known overage is recorded exactly; remaining is not silently clamped.
    const settled = await s.budget.settle(job, 1, { costFen: 120, timeMs: 900 })
    assert.deepEqual(settled, { costFen: 120, timeMs: 900, unknown: false })
    const project = await s.budget.projectBudget("project-1")
    assert.ok(project)
    assert.equal(project.costChargedFen, 120)
    assert.equal(project.remainingFen, 480)
    assert.ok((await s.budget.taskBudget(submitted.task.id))!.costChargedFen === 120)
  } finally { await s.close() }
})

test("A3b P0: an attempt abandoned at the attempt limit still settles its reservations without a live token", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(200, 2000))
    s.clock.advance(61_000)
    assert.equal((await s.repository.claimNext())?.attempt, 2)
    s.clock.advance(61_000)
    assert.equal((await s.repository.claimNext())?.attempt, 3)
    s.clock.advance(61_000)
    // The fourth claim marks the task failed; the old attempt token is gone, so
    // only the terminal settlement can release the persisted reservation.
    assert.equal(await s.repository.claimNext(), null)
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.equal(task.costReservedFen, 0)
    assert.equal(task.costChargedFen, 200)
    assert.equal(task.timeReservedMs, 0)
    assert.equal(project.costReservedFen, 0)
    assert.equal(project.costChargedFen, 200)
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "failed")
    assert.equal(view.error?.code, "TASK_ATTEMPT_EXHAUSTED")

    // Idempotent and owner-scoped; another claim loop cannot double-charge.
    assert.deepEqual(await s.budget.settleTerminalTask({ taskId: submitted.task.id, owner: "account-1" }), { settled: 0 })
    await rejectsTask(s.budget.settleTerminalTask({ taskId: submitted.task.id, owner: "account-2" }), 404, "NOT_FOUND")
    assert.equal(await s.repository.claimNext(), null)
    assert.equal((await s.budget.taskBudget(submitted.task.id))!.costChargedFen, 200)
  } finally { await s.close() }
})

test("A3b P0: finish settles still-reserved calls in the terminal transaction; running tasks cannot be settled", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(100, 1000))
    // A still-running task must not be settled through the token-free path.
    await rejectsTask(s.budget.settleTerminalTask({ taskId: submitted.task.id, owner: "account-1" }), 409, "CONFLICT")
    assert.equal((await s.budget.taskBudget(submitted.task.id))!.costReservedFen, 100)

    const finished = await s.repository.finish(job, { state: "failed", errorCode: "MODEL_FAILED", errorMessage: "模型调用失败。" })
    assert.equal(finished.state, "failed")
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.equal(task.costReservedFen, 0)
    assert.equal(task.costChargedFen, 100)
    assert.equal(task.timeReservedMs, 0)
    assert.equal(project.costReservedFen, 0)
    assert.equal(project.costChargedFen, 100)
    // The terminal path is idempotent and the old attempt token stays fenced.
    assert.deepEqual(await s.budget.settleTerminalTask({ taskId: submitted.task.id, owner: "account-1" }), { settled: 0 })
    await rejectsTask(s.repository.finish(job, { state: "success" }), 409, "CONFLICT")
  } finally { await s.close() }
})

test("A3b P0: a tampered manifest failure also settles abandoned reservations", async () => {
  const s = await setupBudget()
  try {
    await s.budget.registerProjectBudget("project-1", 1000, "operator-1")
    const { submitted, job } = await startTask(s)
    await s.repository.reserveCall(job, 1, 0, estimate(100, 1000))
    await s.database.transaction(connection => connection.query("UPDATE equilens_tasks SET manifest=$1 WHERE id=$2", [JSON.stringify({ tampered: true }), submitted.task.id]))
    s.clock.advance(61_000)
    assert.equal(await s.repository.claimNext(), null)
    const view = await s.repository.get("account-1", submitted.task.id)
    assert.equal(view.state, "failed")
    assert.equal(view.error?.code, "TASK_INPUT_INVALID")
    const task = await s.budget.taskBudget(submitted.task.id)
    const project = await s.budget.projectBudget("project-1")
    assert.ok(task && project)
    assert.equal(task.costReservedFen, 0)
    assert.equal(task.costChargedFen, 100)
    assert.equal(project.costReservedFen, 0)
    assert.equal(project.costChargedFen, 100)
  } finally { await s.close() }
})

test("A3b P1: fen/ms amounts are capped at the frozen 32-bit INTEGER range", async () => {
  const s = await setupBudget()
  try {
    const registered = await s.budget.registerProjectBudget("project-1", MAX_BUDGET_AMOUNT, "operator-1")
    assert.equal(registered.costLimitFen, MAX_BUDGET_AMOUNT)
    await rejectsTask(s.budget.registerProjectBudget("project-1", MAX_BUDGET_AMOUNT + 1, "operator-1"), 422, "INVALID_SUBMISSION")

    const { submitted, job } = await startTask(s)
    // Boundary: a valid int32 amount passes validation but is refused by the
    // task-level ceiling; max+1 is rejected before any reservation.
    await rejectsTask(s.repository.reserveCall(job, 1, 0, { costFen: MAX_BUDGET_AMOUNT + 1, timeMs: 0 }), 422, "INVALID_SUBMISSION")
    assert.equal((await s.budget.taskBudget(submitted.task.id))!.callsUsed, 0)
    await rejectsTask(s.repository.reserveCall(job, 1, 0, { costFen: MAX_BUDGET_AMOUNT, timeMs: 0 }), 409, "BUDGET_EXHAUSTED")
    // NaN / fractional amounts were already invalid; keep the cap checks explicit.
    await rejectsTask(s.budget.registerProjectBudget("project-1", MAX_BUDGET_AMOUNT - 0.5, "operator-1"), 422, "INVALID_SUBMISSION")
  } finally { await s.close() }
})
