import "server-only"
import { taskAdmission } from "./admission"
import { taskExecutorRegistry } from "./executors"
import { TaskError } from "./errors"
import type { ProjectAction } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import { TaskBudgetRepository, type BudgetSettlement, type BudgetUsage, type ProjectBudgetView, type TaskBudgetView } from "./budget"
import { applicationDatabase } from "../database/runtime"
import { parseOperationId, parseTaskRequest, type TaskSubmission } from "./catalog"
import { resolvePublication } from "./publications"
import {
  TaskRepository, type CallBudgetEstimate, type ClaimedTask, type SubmitResult, type TaskView,
} from "./repository"

/**
 * Task service entries for B2/C4 routes and the A3c runner.
 *
 * `authorize` is mandatory and supplied by the caller with C1's
 * requireProjectAccess. Its resolved value (C1 returns ProjectAccess) is only a
 * per-call authorization snapshot and is deliberately ignored here: no role,
 * membership or access result is cached. The service never treats a projectId
 * or accountId from the browser as authorization, and it never accepts a
 * manifest, model address, rule text, executor, per-call price or budget from a
 * paid-call request.
 */
export type ProjectTaskAuthorizer = (
  identity: AuthIdentity,
  projectId: string,
  action: ProjectAction,
) => Promise<unknown>

type TaskRuntime = { repository: TaskRepository; budget: TaskBudgetRepository }

const state = globalThis as typeof globalThis & { equilensTaskRuntime?: Promise<TaskRuntime> }

/** One runtime wiring so the executor and the budget ledger share the same gate. */
export function taskRuntime(): Promise<TaskRuntime> {
  state.equilensTaskRuntime ??= applicationDatabase()
    .then(database => {
      const budget = new TaskBudgetRepository(database)
      return { repository: new TaskRepository(database, { budget }), budget }
    })
    .catch(failure => { delete state.equilensTaskRuntime; throw failure })
  return state.equilensTaskRuntime
}

export async function taskRepository(): Promise<TaskRepository> {
  return (await taskRuntime()).repository
}

export async function taskBudgetRepository(): Promise<TaskBudgetRepository> {
  return (await taskRuntime()).budget
}

export async function submitTask(identity: AuthIdentity, authorize: ProjectTaskAuthorizer, submission: TaskSubmission): Promise<SubmitResult> {
  if (!taskExecutorRegistry.get(submission.kind)) throw new TaskError(503, "SERVICE_UNAVAILABLE", "该任务类型尚未开放。")
  const operationId = parseOperationId(submission.operationId)
  await authorize(identity, submission.projectId, "edit")
  const parsed = parseTaskRequest({
    kind: submission.kind, projectId: submission.projectId, refs: submission.refs, conditions: submission.conditions,
  })
  // Kind-level admission runs before persistence: a kind whose current capability
  // is unverified (e.g. no tested OCR certificate kinds) must never enter the queue.
  const admission = taskAdmission(submission.kind)
  if (admission) await admission({ kind: parsed.kind, projectId: parsed.projectId, refs: parsed.refs, conditions: parsed.conditions })
  // Server-resolved published basis (C6). Missing resolver or blocked basis is
  // fail-closed; the pin is written into the immutable manifest, never the browser.
  const resolution = await resolvePublication(parsed)
  if (resolution.state === "blocked") throw new TaskError(422, "INVALID_SUBMISSION", "已发布依据已停用或待核对，无法提交新任务。")
  const repository = await taskRepository()
  return repository.submit(identity.account.id, operationId, {
    kind: submission.kind, projectId: submission.projectId, refs: submission.refs, conditions: submission.conditions,
  }, resolution.state === "pinned" ? { publications: resolution.pin } : {})
}

export async function getTask(identity: AuthIdentity, authorize: ProjectTaskAuthorizer, id: string): Promise<TaskView> {
  const repository = await taskRepository()
  const task = await repository.get(identity.account.id, id)
  await authorize(identity, task.projectId, "read")
  return task
}

export async function listTasks(identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string): Promise<TaskView[]> {
  await authorize(identity, projectId, "read")
  const repository = await taskRepository()
  return repository.list(identity.account.id, projectId)
}

/**
 * Project paid-call cost ceiling registration. Only a project admin (`manage`)
 * may set this configuration; the ceiling is validated as an integer fen value
 * and the per-call price estimate still comes only from the server-side runner.
 */
export async function registerProjectBudget(
  identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string, costLimitFen: number,
): Promise<ProjectBudgetView> {
  await authorize(identity, projectId, "manage")
  return (await taskBudgetRepository()).registerProjectBudget(projectId, costLimitFen, identity.account.id)
}

export async function projectBudget(
  identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string,
): Promise<ProjectBudgetView | null> {
  await authorize(identity, projectId, "read")
  return (await taskBudgetRepository()).projectBudget(projectId)
}

export async function taskBudget(
  identity: AuthIdentity, authorize: ProjectTaskAuthorizer, taskId: string,
): Promise<TaskBudgetView | null> {
  const task = await getTask(identity, authorize, taskId)
  return (await taskBudgetRepository()).taskBudget(task.id)
}

/**
 * A3c runner entry: reserve all four budgets before sending a paid request.
 * The caller supplies the server-side conservative estimate; nothing here reads
 * browser prices or model addresses.
 */
export async function reservePaidCall(job: ClaimedTask, callNumber: number, elapsedMs: number, estimate: CallBudgetEstimate): Promise<void> {
  return (await taskRepository()).reserveCall(job, callNumber, elapsedMs, estimate)
}

/** A3c runner entry: settle known provider usage exactly, or conservatively for unknown parts. */
export async function settlePaidCall(job: ClaimedTask, callNumber: number, usage: BudgetUsage = {}): Promise<BudgetSettlement> {
  return (await taskBudgetRepository()).settle(job, callNumber, usage)
}

/** A3c runner entry: the provider returned no usable usage; keep the reservation charged. */
export async function settleUnknownPaidCall(job: ClaimedTask, callNumber: number): Promise<BudgetSettlement> {
  return (await taskBudgetRepository()).recordUnknownUsage(job, callNumber)
}

/** A3c runner entry: before a terminal write, charge any still-reserved crashed call once. */
export async function settleOutstandingBudget(job: ClaimedTask): Promise<{ settled: number }> {
  return (await taskBudgetRepository()).settleOutstanding(job)
}

/**
 * A3c/ops terminal settlement when the attempt token or lease is already gone
 * (exhausted/timeout/tampered manifest). The task repository already performs
 * this atomically for its own terminal paths; this entry covers tasks abandoned
 * before that fix shipped or by future recovery tools. Validates owner and
 * terminal state, and is idempotent.
 */
export async function settleTerminalBudget(task: { taskId: string; owner: string }): Promise<{ settled: number }> {
  return (await taskBudgetRepository()).settleTerminalTask(task)
}
