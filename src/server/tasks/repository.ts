import { randomUUID } from "node:crypto"
import type { Connection, Database, Row } from "../database/connection"
import {
  buildTaskManifest, encodeManifest, manifestHash, parseTaskRequest, taskAttemptBudget,
  taskRequestDigest, type ParsedTaskRequest, type TaskKind, type TaskManifest,
} from "./catalog"
import { TaskError } from "./errors"
import { taskLimits } from "./limits"

export type TaskState = "queued" | "running" | "success" | "partial" | "failed" | "cancelled"
export type TaskTerminalState = "success" | "partial" | "failed" | "cancelled"

export type TaskView = {
  id: string
  kind: TaskKind
  projectId: string
  state: TaskState
  stage: string
  createdAt: string
  updatedAt: string
  attempt: number
  maxAttempts: number
  callsUsed: number
  maxCalls: number
  elapsedMs: number
  manifest: TaskManifest
  error: { code: string; message: string } | null
  resultSummary: string | null
}

export type ClaimedTask = {
  id: string
  owner: string
  projectId: string
  kind: TaskKind
  token: string
  attempt: number
  callsUsed: number
  maxCalls: number
  elapsedMs: number
  startedAt: string
  manifest: TaskManifest
}

/**
 * Conservative per-call estimate supplied by the server-side execution layer
 * (A3c). The browser never provides cost, price or model address. A3b persists
 * this estimate as a reservation before the request; unknown provider usage
 * keeps it charged instead of being treated as free.
 */
export type CallBudgetEstimate = {
  /** Worst-case / expected cost pre-charge in fen (integer, >= 0). */
  costFen: number
  /** Worst-case / expected duration pre-charge in ms (integer, >= 0). */
  timeMs: number
}

/**
 * A3b budget seam. It runs inside the reservation transaction, so a failed or
 * missing reservation rolls back the call counter and no paid request follows.
 */
export type TaskBudgetTerminalTarget = { id: string; owner: string }

export type TaskBudgetReservation = {
  reserve(connection: Connection, job: ClaimedTask, callNumber: number, estimate: CallBudgetEstimate): Promise<void>
  /**
   * A3b P0: terminal settlement without an execution token or live lease. The
   * task repository calls this after marking an abandoned attempt failed and
   * before finishing, so crashed/expired reservations cannot stay reserved
   * forever. It must verify the owner and terminal state and be idempotent.
   */
  settleTerminal?(connection: Connection, task: TaskBudgetTerminalTarget): Promise<{ settled: number }>
}

export type TaskRepositoryOptions = {
  now?: () => Date
  id?: () => string
  budget?: TaskBudgetReservation
}

export type SubmitResult = { task: TaskView; created: boolean }

export type TaskOutcome = {
  state: TaskTerminalState
  errorCode?: string
  errorMessage?: string
  resultSummary?: string
}

const terminalStates: readonly TaskState[] = ["success", "partial", "failed", "cancelled"]
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
// Provider parity: GaussDB reports 23505, node:sqlite reports ERR_SQLITE_ERROR
// with the extended constraint code (1555 primary key / 2067 unique).
const uniqueViolation = (failure: unknown) => {
  const value = failure as { code?: string; errcode?: number }
  return value.code === "23505" || value.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY"
    || value.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || value.errcode === 1555 || value.errcode === 2067
}

/**
 * Elapsed recovery for a previously-running row. The last lease end bounds the
 * time a crashed attempt could have used; NULL or malformed timestamps degrade
 * to zero instead of NaN.
 */
function recoveredElapsed(now: Date, row: Row): number {
  if (!row.lease_until) return 0
  const leaseUntil = Date.parse(String(row.lease_until))
  const updatedAt = Date.parse(String(row.updated_at))
  if (!Number.isFinite(leaseUntil) || !Number.isFinite(updatedAt)) return 0
  return Math.max(0, Math.min(now.getTime(), leaseUntil) - updatedAt)
}

function view(row: Row): TaskView {
  return {
    id: String(row.id),
    kind: String(row.kind) as TaskKind,
    projectId: String(row.project_id),
    state: String(row.state) as TaskState,
    stage: String(row.stage),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    callsUsed: Number(row.calls_used),
    maxCalls: Number(row.max_calls),
    elapsedMs: Number(row.elapsed_ms),
    manifest: parse<TaskManifest>(row.manifest),
    error: row.error_code ? { code: String(row.error_code), message: String(row.error_message ?? "") } : null,
    resultSummary: row.result_summary ? String(row.result_summary) : null,
  }
}

/**
 * Persistent shared task queue (A3a).
 *
 * Submission persists a queued task before any execution, with per-account
 * operationId idempotency, a fixed server-side manifest and atomic admission
 * (queue 10, unfinished per account 2). Claim/heartbeat/reserve/finish reuse the
 * existing contract-review lease and execution-token semantics: one global
 * lease row, per-attempt tokens, conditional UPDATEs. This class contains no
 * execution loop; A3c is the single runner that claims through it.
 */
export class TaskRepository {
  private readonly now: () => Date
  private readonly nextId: () => string
  private readonly budget?: TaskBudgetReservation

  constructor(private readonly database: Database, options: TaskRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.nextId = options.id ?? randomUUID
    this.budget = options.budget
  }

  private clock(): string { return this.now().toISOString() }
  private leaseFrom(now: Date): string { return new Date(now.getTime() + taskLimits.leaseMs).toISOString() }

  private async owned(connection: Connection, owner: string, id: string): Promise<Row> {
    const row = (await connection.query("SELECT * FROM equilens_tasks WHERE owner=$1 AND id=$2", [owner, id])).rows[0]
    if (!row) throw new TaskError(404, "NOT_FOUND", "找不到该任务。")
    return row
  }

  private async executing(connection: Connection, job: ClaimedTask): Promise<Row> {
    const row = await this.owned(connection, job.owner, job.id)
    if (row.state !== "running" || row.execution_token !== job.token
      || !row.lease_until || String(row.lease_until) <= this.clock()) {
      throw new TaskError(409, "CONFLICT", "任务执行权已变化，请重新读取状态。")
    }
    return row
  }

  private async releaseRunner(connection: Connection, token: string): Promise<void> {
    await connection.query("UPDATE equilens_task_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
  }

  /**
   * Persist a queued task. Same account + project + operationId + same input
   * returns the original task; the same key with a different input conflicts.
   */
  async submit(owner: string, operationId: string, request: unknown): Promise<SubmitResult> {
    const parsed: ParsedTaskRequest = parseTaskRequest(request)
    const requestHash = taskRequestDigest(parsed)
    const work = () => this.database.transaction(async connection => {
      // Side-effect-free row lock: serialises the idempotency lookup, admission
      // counts and insert across connections/providers.
      await connection.query("UPDATE equilens_task_runner SET id=id WHERE id=1")
      const prior = (await connection.query("SELECT * FROM equilens_tasks WHERE owner=$1 AND project_id=$2 AND operation_id=$3", [owner, parsed.projectId, operationId])).rows[0]
      if (prior) {
        if (String(prior.request_hash) !== requestHash) throw new TaskError(409, "CONFLICT", "此提交标识已用于不同的任务输入。")
        return { task: view(prior), created: false }
      }
      const clock = this.clock()
      const unfinished = (await connection.query(
        "SELECT owner,state FROM equilens_tasks WHERE state IN ('queued','running') AND (expires_at IS NULL OR expires_at>$1)",
        [clock],
      )).rows
      if (unfinished.filter(row => row.state === "queued").length >= taskLimits.maxQueued) {
        throw new TaskError(429, "LIMIT_EXCEEDED", "任务队列已满，请稍后提交。")
      }
      if (unfinished.filter(row => row.owner === owner).length >= taskLimits.maxUnfinishedPerOwner) {
        throw new TaskError(429, "LIMIT_EXCEEDED", `每位用户最多保留 ${taskLimits.maxUnfinishedPerOwner} 个未终结任务，请稍后提交。`)
      }
      const id = this.nextId()
      const manifest = buildTaskManifest(parsed, owner, clock)
      const encoded = encodeManifest(manifest)
      const budgets = taskAttemptBudget(parsed.kind)
      await connection.query(
        "INSERT INTO equilens_tasks(id,kind,owner,project_id,operation_id,request_hash,manifest,manifest_hash,state,stage,created_at,updated_at,expires_at,attempt,max_attempts,calls_used,max_calls,elapsed_ms,max_cost_fen,cost_reserved_fen,cost_charged_fen,time_reserved_ms,time_charged_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued','submitted',$9,$10,NULL,0,$11,0,$12,0,$13,0,0,0,0)",
        [id, parsed.kind, owner, parsed.projectId, operationId, requestHash, encoded, manifestHash(encoded), clock, clock, budgets.maxAttempts, budgets.maxCalls, budgets.maxCostFen],
      )
      return { task: view(await this.owned(connection, owner, id)), created: true }
    })
    try { return await work() }
    catch (failure) {
      // A concurrent duplicate insert surfaces as a unique violation after the
      // competing transaction commits; re-running returns the original task.
      if (uniqueViolation(failure)) return work()
      throw failure
    }
  }

  async get(owner: string, id: string): Promise<TaskView> {
    return this.database.transaction(async connection => view(await this.owned(connection, owner, id)))
  }

  async list(owner: string, projectId?: string): Promise<TaskView[]> {
    return this.database.transaction(async connection => {
      const values: (string | number | null)[] = projectId ? [owner, projectId] : [owner]
      const { rows } = await connection.query(
        "SELECT * FROM equilens_tasks WHERE owner=$1" + (projectId ? " AND project_id=$2" : "") + " ORDER BY created_at DESC,id DESC LIMIT 50",
        values,
      )
      return rows.map(view)
    })
  }

  /**
   * Claim the next queued (or lease-expired running) task under the single
   * global execution lease. Returns null when another attempt holds the lease.
   */
  async claimNext(): Promise<ClaimedTask | null> {
    return this.database.transaction(async connection => {
      const now = this.now()
      const clock = now.toISOString()
      const until = this.leaseFrom(now)
      const token = this.nextId()
      const acquired = await connection.query(
        "UPDATE equilens_task_runner SET token=$1,lease_until=$2 WHERE id=1 AND (lease_until IS NULL OR lease_until<=$3)",
        [token, until, clock],
      )
      if (acquired.changes !== 1) return null
      const row = (await connection.query(
        "SELECT * FROM equilens_tasks WHERE (state='queued' OR (state='running' AND (lease_until IS NULL OR lease_until<=$1))) AND (expires_at IS NULL OR expires_at>$2) ORDER BY created_at,id LIMIT 1",
        [clock, clock],
      )).rows[0]
      if (!row) { await this.releaseRunner(connection, token); return null }
      const attempt = Number(row.attempt)
      const callsUsed = Number(row.calls_used)
      const maxCalls = Number(row.max_calls)
      // A recovered running row can have a NULL lease_until (crash before the
      // claim was recorded); never let that become NaN elapsed time.
      const recovered = row.state === "running" ? recoveredElapsed(now, row) : 0
      const elapsed = Number(row.elapsed_ms) + recovered
      const exhausted = elapsed >= taskLimits.maxElapsedMs ? "TASK_TIMEOUT"
        : attempt >= Number(row.max_attempts) ? "TASK_ATTEMPT_EXHAUSTED"
          : maxCalls > 0 && callsUsed >= maxCalls ? "TASK_BUDGET_EXHAUSTED"
            : null
      if (exhausted) {
        await connection.query(
          "UPDATE equilens_tasks SET state='failed',stage='failed',execution_token=NULL,lease_until=NULL,error_code=$1,error_message=$2,updated_at=$3 WHERE id=$4",
          [exhausted, "任务已达到累计预算或尝试次数上限。", clock, String(row.id)],
        )
        // P0: no live token remains, so settle the abandoned attempt's
        // reservations without requiring one. Runs in this transaction.
        await this.budget?.settleTerminal?.(connection, { id: String(row.id), owner: String(row.owner) })
        await this.releaseRunner(connection, token)
        return null
      }
      const nextAttempt = attempt + 1
      const claimed = await connection.query(
        "UPDATE equilens_tasks SET state='running',stage='claimed',attempt=$1,execution_token=$2,lease_until=$3,attempt_started_at=$4,updated_at=$5,elapsed_ms=$6,error_code=NULL,error_message=NULL WHERE id=$7 AND state=$8 AND attempt=$9 AND (lease_until IS NULL OR lease_until<=$10)",
        [nextAttempt, token, until, clock, clock, Math.floor(elapsed), String(row.id), String(row.state), attempt, clock],
      )
      if (claimed.changes !== 1) { await this.releaseRunner(connection, token); return null }
      // The stored manifest must still hash to its recorded digest; a mismatch
      // means the stored input was altered out-of-band and execution must stop.
      const encoded = String(row.manifest)
      if (manifestHash(encoded) !== String(row.manifest_hash)) {
        await connection.query(
          "UPDATE equilens_tasks SET state='failed',stage='failed',execution_token=NULL,lease_until=NULL,error_code='TASK_INPUT_INVALID',error_message=$1,updated_at=$2 WHERE id=$3",
          ["任务输入快照校验失败。", clock, String(row.id)],
        )
        await this.budget?.settleTerminal?.(connection, { id: String(row.id), owner: String(row.owner) })
        await this.releaseRunner(connection, token)
        return null
      }
      return {
        id: String(row.id),
        owner: String(row.owner),
        projectId: String(row.project_id),
        kind: String(row.kind) as TaskKind,
        token,
        attempt: nextAttempt,
        callsUsed,
        maxCalls,
        elapsedMs: Math.floor(elapsed),
        startedAt: clock,
        manifest: parse<TaskManifest>(encoded),
      }
    })
  }

  /** Renew both the task lease and the global execution lease. */
  async heartbeat(job: ClaimedTask, elapsedMs: number): Promise<void> {
    await this.database.transaction(async connection => {
      await this.executing(connection, job)
      const clock = this.clock()
      const until = this.leaseFrom(this.now())
      const lock = await connection.query(
        "UPDATE equilens_task_runner SET lease_until=$1 WHERE id=1 AND token=$2 AND lease_until>$3",
        [until, job.token, clock],
      )
      if (lock.changes !== 1) throw new TaskError(409, "CONFLICT", "任务执行权已变化，请重新读取状态。")
      const update = await connection.query(
        "UPDATE equilens_tasks SET lease_until=$1,elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND state='running'",
        [until, elapsedMs, clock, job.id, job.token],
      )
      if (update.changes !== 1) throw new TaskError(409, "CONFLICT", "任务执行权已变化，请重新读取状态。")
    })
  }

  /**
   * Persist the paid-call reservation before the external request. The call,
   * time, task-cost and project-cost reservation all commit in this transaction
   * (A3b); throwing here aborts it, so no counter changes and no external
   * request follow. A paid kind without a registered project budget is refused.
   */
  async reserveCall(job: ClaimedTask, callNumber: number, elapsedMs: number, estimate: CallBudgetEstimate): Promise<void> {
    await this.database.transaction(async connection => {
      const row = await this.executing(connection, job)
      const callsUsed = Number(row.calls_used)
      const maxCalls = Number(row.max_calls)
      if (maxCalls <= 0 || callNumber !== callsUsed + 1 || callNumber > maxCalls || elapsedMs >= taskLimits.maxElapsedMs) {
        throw new TaskError(409, "CONFLICT", "任务调用预算不允许本次外部请求。")
      }
      if (!this.budget) throw new TaskError(409, "BUDGET_EXHAUSTED", "任务费用预算未登记，不能发起外部请求。")
      await this.budget.reserve(connection, job, callNumber, estimate)
      const update = await connection.query(
        "UPDATE equilens_tasks SET calls_used=$1,elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND calls_used=$6 AND state='running'",
        [callNumber, elapsedMs, this.clock(), job.id, job.token, callNumber - 1],
      )
      if (update.changes !== 1) throw new TaskError(409, "CONFLICT", "任务调用预算不允许本次外部请求。")
    })
  }

  /** Write the terminal state only under the current attempt token. */
  async finish(job: ClaimedTask, outcome: TaskOutcome): Promise<TaskView> {
    if (!terminalStates.includes(outcome.state)) throw new TaskError(422, "INVALID_SUBMISSION", "任务终态无效。")
    return this.database.transaction(async connection => {
      await this.executing(connection, job)
      const clock = this.clock()
      const update = await connection.query(
        "UPDATE equilens_tasks SET state=$1,stage=$2,execution_token=NULL,lease_until=NULL,error_code=$3,error_message=$4,result_summary=$5,updated_at=$6 WHERE id=$7 AND execution_token=$8 AND state='running'",
        [outcome.state, outcome.state, outcome.errorCode ?? null, outcome.errorMessage ?? null, outcome.resultSummary ?? null, clock, job.id, job.token],
      )
      if (update.changes !== 1) throw new TaskError(409, "CONFLICT", "任务执行权已变化，请重新读取状态。")
      // P0: a terminal finish always settles any still-reserved paid call
      // conservatively in the same transaction; A3c may have already settled
      // the known usage, in which case this is an idempotent no-op.
      await this.budget?.settleTerminal?.(connection, { id: job.id, owner: job.owner })
      await this.releaseRunner(connection, job.token)
      return view(await this.owned(connection, job.owner, job.id))
    })
  }
}
