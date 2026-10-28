import type { Connection, Database, Row } from "../database/connection"
import { TaskError } from "./errors"
import { taskLimits } from "./limits"
import type { CallBudgetEstimate, ClaimedTask, TaskBudgetReservation } from "./repository"

/**
 * Persistent task/project budget ledger (A3b).
 *
 * Calls, time, task cost and project cost are reserved separately inside the
 * same database transaction as A3a's call counter, before any paid external
 * request. Reservations survive a crash and are never reset by a retry or a
 * recovery attempt. Unknown provider usage keeps the reservation charged
 * (conservative); known usage moves the exact amount. A paid kind without a
 * registered project budget is refused, so no external request is sent.
 *
 * Prices/estimates come only from the server-side execution layer (A3c);
 * browser input never supplies cost, price, model address or budget.
 */
export type BudgetUsage = {
  /** Known provider cost; null/undefined means unknown and stays conservative. */
  costFen?: number | null
  /** Known elapsed time; null/undefined means unknown and stays conservative. */
  timeMs?: number | null
}

export type BudgetSettlement = {
  costFen: number
  timeMs: number
  unknown: boolean
}

export type ProjectBudgetView = {
  projectId: string
  costLimitFen: number
  costReservedFen: number
  costChargedFen: number
  /** Raw remaining amount; it may be negative after a known overage (no clamping). */
  remainingFen: number
  registeredBy: string
  registeredAt: string
  updatedAt: string
  revision: number
}

export type TaskBudgetView = {
  taskId: string
  maxCostFen: number
  costReservedFen: number
  costChargedFen: number
  timeReservedMs: number
  timeChargedMs: number
  maxElapsedMs: number
  callsUsed: number
  maxCalls: number
}

const integerAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/**
 * GaussDB INTEGER is 32-bit; 0005 is frozen, so validation caps every persisted
 * fen/ms amount at 2^31-1 instead of changing the column to BIGINT (a new 0007
 * would be required for larger totals).
 */
export const MAX_BUDGET_AMOUNT = 2_147_483_647

function amount(value: unknown, message: string): number {
  if (!integerAmount(value) || value > MAX_BUDGET_AMOUNT) throw new TaskError(422, "INVALID_SUBMISSION", message)
  return value
}

function key(value: unknown, message: string, maximum = 64): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maximum - 1}}$`).test(value)) {
    throw new TaskError(422, "INVALID_SUBMISSION", message)
  }
  return value
}

function budgetError(message: string): TaskError {
  return new TaskError(409, "BUDGET_EXHAUSTED", message)
}

const terminalStates: readonly string[] = ["success", "partial", "failed", "cancelled"]

/** Terminal settlement target: the owner is the submitting account, never a browser claim. */
export type TerminalSettlementTarget = { id: string; owner: string }
export type TerminalSettlementRequest = { taskId: string; owner: string }

function duplicate(failure: unknown): boolean {
  const value = failure as { code?: string; errcode?: number }
  return value.code === "23505" || value.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY"
    || value.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || value.errcode === 1555 || value.errcode === 2067
}

function projectView(row: Row): ProjectBudgetView {
  const limit = Number(row.cost_limit_fen)
  const reserved = Number(row.cost_reserved_fen)
  const charged = Number(row.cost_charged_fen)
  return {
    projectId: String(row.project_id),
    costLimitFen: limit,
    costReservedFen: reserved,
    costChargedFen: charged,
    remainingFen: limit - reserved - charged,
    registeredBy: String(row.registered_by),
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision),
  }
}

type TaskBudgetRow = {
  id: string
  projectId: string
  maxCostFen: number
  costReservedFen: number
  costChargedFen: number
  timeReservedMs: number
  timeChargedMs: number
  callsUsed: number
  maxCalls: number
}

function taskBudgetRow(row: Row): TaskBudgetRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    maxCostFen: Number(row.max_cost_fen),
    costReservedFen: Number(row.cost_reserved_fen),
    costChargedFen: Number(row.cost_charged_fen),
    timeReservedMs: Number(row.time_reserved_ms),
    timeChargedMs: Number(row.time_charged_ms),
    callsUsed: Number(row.calls_used),
    maxCalls: Number(row.max_calls),
  }
}

export class TaskBudgetRepository implements TaskBudgetReservation {
  private readonly now: () => Date

  constructor(private readonly database: Database, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date())
  }

  private clock(): string { return this.now().toISOString() }

  /**
   * Register or update a project's paid-call cost ceiling. A project owner sets
   * this from the server-side project settings; lowering it below the already
   * reserved/charged amount is refused.
   */
  async registerProjectBudget(projectId: string, costLimitFen: number, registeredBy: string): Promise<ProjectBudgetView> {
    const id = key(projectId, "项目标识无效。")
    const limit = amount(costLimitFen, "项目费用预算无效。")
    const actor = key(registeredBy, "预算登记人无效。", 36)
    const work = () => this.database.transaction(async connection => {
      // Side-effect-free row lock so concurrent reservations/registrations serialise.
      await connection.query("UPDATE equilens_project_budgets SET project_id=project_id WHERE project_id=$1", [id])
      const clock = this.clock()
      const row = (await connection.query("SELECT * FROM equilens_project_budgets WHERE project_id=$1", [id])).rows[0]
      if (!row) {
        await connection.query(
          "INSERT INTO equilens_project_budgets(project_id,cost_limit_fen,cost_reserved_fen,cost_charged_fen,registered_by,registered_at,updated_at,revision) VALUES($1,$2,0,0,$3,$4,$5,1)",
          [id, limit, actor, clock, clock],
        )
        return projectView((await connection.query("SELECT * FROM equilens_project_budgets WHERE project_id=$1", [id])).rows[0])
      }
      const committed = Number(row.cost_reserved_fen) + Number(row.cost_charged_fen)
      if (limit < committed) throw new TaskError(409, "CONFLICT", "项目费用预算不得低于已预留和已用金额。")
      const updated = await connection.query(
        "UPDATE equilens_project_budgets SET cost_limit_fen=$1,updated_at=$2,revision=revision+1 WHERE project_id=$3 AND revision=$4",
        [limit, clock, id, Number(row.revision)],
      )
      if (updated.changes !== 1) throw new TaskError(409, "CONFLICT", "项目费用预算已变化，请刷新后重试。")
      return projectView({ ...row, cost_limit_fen: limit, updated_at: clock, revision: Number(row.revision) + 1 })
    })
    try { return await work() }
    catch (failure) { if (duplicate(failure)) return work(); throw failure }
  }

  async projectBudget(projectId: string): Promise<ProjectBudgetView | null> {
    const id = key(projectId, "项目标识无效。")
    return this.database.transaction(async connection => {
      const row = (await connection.query("SELECT * FROM equilens_project_budgets WHERE project_id=$1", [id])).rows[0]
      return row ? projectView(row) : null
    })
  }

  async taskBudget(taskId: string): Promise<TaskBudgetView | null> {
    const id = key(taskId, "任务标识无效。")
    return this.database.transaction(async connection => {
      const row = (await connection.query("SELECT id,project_id,max_cost_fen,cost_reserved_fen,cost_charged_fen,time_reserved_ms,time_charged_ms,calls_used,max_calls FROM equilens_tasks WHERE id=$1", [id])).rows[0]
      if (!row) return null
      const budget = taskBudgetRow(row)
      return {
        taskId: budget.id,
        maxCostFen: budget.maxCostFen,
        costReservedFen: budget.costReservedFen,
        costChargedFen: budget.costChargedFen,
        timeReservedMs: budget.timeReservedMs,
        timeChargedMs: budget.timeChargedMs,
        maxElapsedMs: taskLimits.maxElapsedMs,
        callsUsed: budget.callsUsed,
        maxCalls: budget.maxCalls,
      }
    })
  }

  /**
   * A3a invokes this inside the call-reservation transaction. All four budgets
   * are checked and persisted atomically; any refusal rolls back the call
   * counter so the external request is never sent.
   */
  async reserve(connection: Connection, job: ClaimedTask, callNumber: number, estimate: CallBudgetEstimate): Promise<void> {
    const cost = amount(estimate?.costFen, "调用费用预算估算无效。")
    const time = amount(estimate?.timeMs, "调用时间预算估算无效。")
    if (!Number.isSafeInteger(callNumber) || callNumber < 1) throw new TaskError(422, "INVALID_SUBMISSION", "调用序号无效。")
    const clock = this.clock()
    const taskRow = await this.executingRow(connection, job, clock)
    const existing = (await connection.query(
      "SELECT cost_reserved_fen,time_reserved_ms FROM equilens_task_budget_reservations WHERE task_id=$1 AND attempt=$2 AND call_number=$3",
      [job.id, job.attempt, callNumber],
    )).rows[0]
    if (existing) {
      // Same attempt/call can only be reserved with the same estimate: a
      // repeated reservation after a lost response must not double-charge.
      if (Number(existing.cost_reserved_fen) !== cost || Number(existing.time_reserved_ms) !== time) {
        throw new TaskError(409, "CONFLICT", "预算预留内容不一致，请重新读取任务状态。")
      }
      return
    }
    if (taskRow.costReservedFen + taskRow.costChargedFen + cost > taskRow.maxCostFen) {
      throw budgetError("任务费用预算不足，不能发起外部请求。")
    }
    if (taskRow.timeReservedMs + taskRow.timeChargedMs + time > taskLimits.maxElapsedMs) {
      throw budgetError("任务时间预算不足，不能发起外部请求。")
    }
    const projectId = taskRow.projectId
    const project = (await connection.query("SELECT * FROM equilens_project_budgets WHERE project_id=$1", [projectId])).rows[0]
    if (!project) throw budgetError("项目费用预算未登记，不能发起外部请求。")
    const projectReserved = Number(project.cost_reserved_fen)
    const projectCharged = Number(project.cost_charged_fen)
    if (projectReserved + projectCharged + cost > Number(project.cost_limit_fen)) {
      throw budgetError("项目费用预算不足，不能发起外部请求。")
    }
    await connection.query(
      "INSERT INTO equilens_task_budget_reservations(task_id,attempt,call_number,project_id,cost_reserved_fen,time_reserved_ms,actual_cost_fen,actual_time_ms,usage_known,status,created_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,0,0,0,'reserved',$7,NULL)",
      [job.id, job.attempt, callNumber, projectId, cost, time, clock],
    )
    const taskUpdate = await connection.query(
      "UPDATE equilens_tasks SET cost_reserved_fen=$1,time_reserved_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND cost_reserved_fen=$6 AND time_reserved_ms=$7 AND state='running'",
      [taskRow.costReservedFen + cost, taskRow.timeReservedMs + time, clock, job.id, job.token, taskRow.costReservedFen, taskRow.timeReservedMs],
    )
    if (taskUpdate.changes !== 1) throw new TaskError(409, "CONFLICT", "任务预算状态已变化，请重试。")
    const projectUpdate = await connection.query(
      "UPDATE equilens_project_budgets SET cost_reserved_fen=$1,updated_at=$2,revision=revision+1 WHERE project_id=$3 AND cost_reserved_fen=$4 AND cost_charged_fen=$5 AND revision=$6",
      [projectReserved + cost, clock, projectId, projectReserved, projectCharged, Number(project.revision)],
    )
    if (projectUpdate.changes !== 1) throw new TaskError(409, "CONFLICT", "项目费用预算已变化，请重试。")
  }

  /**
   * Move a reservation from "reserved" to "charged" after the external call.
   * Unknown usage (missing provider numbers) keeps the conservative reserved
   * amount charged; known usage records the exact amount (a known overage is
   * recorded, never clamped to zero).
   */
  async settle(job: ClaimedTask, callNumber: number, usage: BudgetUsage = {}): Promise<BudgetSettlement> {
    return this.database.transaction(async connection => {
      const clock = this.clock()
      const taskRow = await this.executingRow(connection, job, clock)
      const row = (await connection.query(
        "SELECT * FROM equilens_task_budget_reservations WHERE task_id=$1 AND attempt=$2 AND call_number=$3",
        [job.id, job.attempt, callNumber],
      )).rows[0]
      if (!row) throw new TaskError(409, "CONFLICT", "预算预留不存在。")
      if (row.status === "settled") {
        return { costFen: Number(row.actual_cost_fen), timeMs: Number(row.actual_time_ms), unknown: Number(row.usage_known) !== 1 }
      }
      const reservedCost = Number(row.cost_reserved_fen)
      const reservedTime = Number(row.time_reserved_ms)
      const knownCost = usage.costFen === undefined || usage.costFen === null ? null : amount(usage.costFen, "实际费用用量无效。")
      const knownTime = usage.timeMs === undefined || usage.timeMs === null ? null : amount(usage.timeMs, "实际时间用量无效。")
      const actualCost = knownCost ?? reservedCost
      const actualTime = knownTime ?? reservedTime
      const unknown = knownCost === null || knownTime === null
      const settled = await connection.query(
        "UPDATE equilens_task_budget_reservations SET status='settled',actual_cost_fen=$1,actual_time_ms=$2,usage_known=$3,settled_at=$4 WHERE task_id=$5 AND attempt=$6 AND call_number=$7 AND status='reserved'",
        [actualCost, actualTime, unknown ? 0 : 1, clock, job.id, job.attempt, callNumber],
      )
      if (settled.changes !== 1) throw new TaskError(409, "CONFLICT", "预算预留已结算，请重试。")
      await this.moveTaskCounters(connection, taskRow, reservedCost, reservedTime, actualCost, actualTime, clock)
      await this.moveProjectCounters(connection, taskRow.projectId, reservedCost, actualCost, clock)
      return { costFen: actualCost, timeMs: actualTime, unknown }
    })
  }

  /** Convenience for a provider response without usable usage numbers. */
  recordUnknownUsage(job: ClaimedTask, callNumber: number): Promise<BudgetSettlement> {
    return this.settle(job, callNumber, {})
  }

  /**
   * Terminal conservative settlement for the current attempt: every
   * still-reserved call is charged at its reserved amount. Idempotent; called by
   * A3c while the attempt token is still current.
   */
  async settleOutstanding(job: ClaimedTask): Promise<{ settled: number }> {
    return this.database.transaction(async connection => {
      const taskRow = await this.executingRow(connection, job, this.clock())
      return this.settleReservedIn(connection, taskRow, job.id)
    })
  }

  /**
   * Terminal settlement used by the task repository (A3b P0). It intentionally
   * does not require an execution token or lease: the attempt may already have
   * been abandoned (exhausted/timeout/tampered manifest) and its token cleared.
   * It still verifies the owner and that the task is in a terminal state, and is
   * idempotent through the `status='reserved'` filter.
   *
   * Runs inside the caller's transaction so the terminal state, budget ledger
   * and call counters commit atomically.
   */
  async settleTerminal(connection: Connection, task: TerminalSettlementTarget): Promise<{ settled: number }> {
    const row = (await connection.query(
      "SELECT id,project_id,max_cost_fen,cost_reserved_fen,cost_charged_fen,time_reserved_ms,time_charged_ms,calls_used,max_calls,owner,state FROM equilens_tasks WHERE id=$1 AND owner=$2",
      [task.id, task.owner],
    )).rows[0]
    if (!row) throw new TaskError(404, "NOT_FOUND", "找不到该任务。")
    if (!terminalStates.includes(String(row.state))) {
      throw new TaskError(409, "CONFLICT", "任务尚未终结，不能执行终态预算结算。")
    }
    return this.settleReservedIn(connection, taskBudgetRow(row), task.id)
  }

  /** Standalone terminal settlement (A3c/ops): validates owner + terminal state, idempotent. */
  async settleTerminalTask(task: TerminalSettlementRequest): Promise<{ settled: number }> {
    const taskId = key(task?.taskId, "任务标识无效。")
    const owner = key(task?.owner, "任务提交人无效。", 36)
    return this.database.transaction(async connection => this.settleTerminal(connection, { id: taskId, owner }))
  }

  private async settleReservedIn(connection: Connection, task: TaskBudgetRow, taskId: string): Promise<{ settled: number }> {
    const clock = this.clock()
    const rows = (await connection.query(
      "SELECT * FROM equilens_task_budget_reservations WHERE task_id=$1 AND status='reserved' ORDER BY attempt,call_number",
      [taskId],
    )).rows
    if (!rows.length) return { settled: 0 }
    let reservedCost = 0
    let reservedTime = 0
    for (const row of rows) {
      const cost = Number(row.cost_reserved_fen)
      const time = Number(row.time_reserved_ms)
      const changed = await connection.query(
        "UPDATE equilens_task_budget_reservations SET status='settled',actual_cost_fen=$1,actual_time_ms=$2,usage_known=0,settled_at=$3 WHERE task_id=$4 AND attempt=$5 AND call_number=$6 AND status='reserved'",
        [cost, time, clock, taskId, Number(row.attempt), Number(row.call_number)],
      )
      if (changed.changes !== 1) throw new TaskError(409, "CONFLICT", "预算预留已结算，请重试。")
      reservedCost += cost
      reservedTime += time
    }
    // Unknown/crashed usage is charged at the conservative reserved amount once.
    await this.moveTaskCounters(connection, task, reservedCost, reservedTime, reservedCost, reservedTime, clock)
    await this.moveProjectCounters(connection, task.projectId, reservedCost, reservedCost, clock)
    return { settled: rows.length }
  }

  private async executingRow(connection: Connection, job: ClaimedTask, clock: string): Promise<TaskBudgetRow> {
    const row = (await connection.query(
      "SELECT id,project_id,max_cost_fen,cost_reserved_fen,cost_charged_fen,time_reserved_ms,time_charged_ms,calls_used,max_calls,execution_token,state,lease_until FROM equilens_tasks WHERE id=$1 AND owner=$2",
      [job.id, job.owner],
    )).rows[0]
    if (!row) throw new TaskError(404, "NOT_FOUND", "找不到该任务。")
    if (row.state !== "running" || row.execution_token !== job.token
      || !row.lease_until || String(row.lease_until) <= clock) {
      throw new TaskError(409, "CONFLICT", "任务执行权已变化，请重新读取状态。")
    }
    return taskBudgetRow(row)
  }

  private async moveTaskCounters(connection: Connection, task: TaskBudgetRow, reservedCost: number, reservedTime: number, actualCost: number, actualTime: number, clock: string): Promise<void> {
    const changed = await connection.query(
      "UPDATE equilens_tasks SET cost_reserved_fen=cost_reserved_fen-$1,cost_charged_fen=cost_charged_fen+$2,time_reserved_ms=time_reserved_ms-$3,time_charged_ms=time_charged_ms+$4,updated_at=$5 WHERE id=$6 AND cost_reserved_fen=$7 AND time_reserved_ms=$8",
      [reservedCost, actualCost, reservedTime, actualTime, clock, task.id, task.costReservedFen, task.timeReservedMs],
    )
    if (changed.changes !== 1) throw new TaskError(409, "CONFLICT", "任务预算状态已变化，请重试。")
  }

  private async moveProjectCounters(connection: Connection, projectId: string, reservedCost: number, actualCost: number, clock: string): Promise<void> {
    const project = (await connection.query("SELECT * FROM equilens_project_budgets WHERE project_id=$1", [projectId])).rows[0]
    if (!project) throw new TaskError(409, "CONFLICT", "项目费用预算记录缺失，不能结算。")
    const changed = await connection.query(
      "UPDATE equilens_project_budgets SET cost_reserved_fen=cost_reserved_fen-$1,cost_charged_fen=cost_charged_fen+$2,updated_at=$3,revision=revision+1 WHERE project_id=$4 AND cost_reserved_fen=$5 AND revision=$6",
      [reservedCost, actualCost, clock, projectId, Number(project.cost_reserved_fen), Number(project.revision)],
    )
    if (changed.changes !== 1) throw new TaskError(409, "CONFLICT", "项目费用预算已变化，请重试。")
  }
}
