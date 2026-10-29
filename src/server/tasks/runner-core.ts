import { isBusinessError } from "../projects/errors"
import { estimateTaskCall } from "./estimates"
import type { BudgetUsage } from "./budget"
import type { TaskKind } from "./catalog"
import type { CallBudgetEstimate, ClaimedTask, TaskRepository } from "./repository"
export type TaskExecutionResult = { outcome: "success" | "partial" | "failed" | "cancelled"; resultSummary?: string; errorCode?: string; errorMessage?: string }
export type TaskExecutor = (job: ClaimedTask, context: {
  signal: AbortSignal
  heartbeat(elapsedMs: number): Promise<void>
  refreshAccess(): Promise<void>
  reserveCall(callNumber: number, estimate: CallBudgetEstimate): Promise<void>
  settleCall(callNumber: number, usage?: BudgetUsage): Promise<void>
}) => Promise<TaskExecutionResult>
export type RunnerDependencies = {
  repository: Pick<TaskRepository, "claimNext" | "heartbeat" | "finish">
  authorize(job: ClaimedTask): Promise<void>
  executor(kind: TaskKind): TaskExecutor | null
  review(): Promise<void>
  settle(job: ClaimedTask): Promise<unknown>
  reserve(job: ClaimedTask, call: number, elapsed: number, estimate: CallBudgetEstimate): Promise<void>
  settleCall(job: ClaimedTask, call: number, usage?: BudgetUsage): Promise<unknown>
}
export function createUnifiedRunner(deps: RunnerDependencies) {
  let stopped = false
  let work: Promise<void> | undefined
  let controller: AbortController | undefined
  async function execute() {
    const job = await deps.repository.claimNext()
    if (!job) { if (!stopped) await deps.review(); return }
    if (stopped) { await deps.settle(job); await deps.repository.finish(job, { state: "cancelled" }); return }
    controller = new AbortController()
    const active = controller
    const began = Date.now()
    const elapsed = () => job.elapsedMs + Date.now() - began
    const refreshAccess = async () => {
      active.signal.throwIfAborted()
      try { await deps.authorize(job) } catch (failure) {
        if (!isBusinessError(failure) || !["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(failure.code)) throw failure
        throw Object.assign(Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })
      }
    }
    let heartbeatFailure: unknown
    let heartbeatWork: Promise<void> | undefined
    const timer = setInterval(() => {
      if (heartbeatWork) return
      heartbeatWork = deps.repository.heartbeat(job, elapsed()).catch(failure => {
        heartbeatFailure = failure
        active.abort(failure)
      }).finally(() => { heartbeatWork = undefined })
    }, 15000)
    timer.unref()
    try {
      await refreshAccess()
      const executor = deps.executor(job.kind)
      if (!executor) throw Object.assign(Error("该任务类型尚未开放。"), { code: "SERVICE_UNAVAILABLE" })
      const result = await executor(job, {
        signal: active.signal,
        heartbeat: value => deps.repository.heartbeat(job, value), refreshAccess,
        reserveCall: async (call) => { await refreshAccess(); await deps.reserve(job, call, elapsed(), estimateTaskCall(job.kind, call)) },
        settleCall: async (call, usage) => { await deps.settleCall(job, call, usage) },
      })
      if (heartbeatFailure) throw heartbeatFailure
      await refreshAccess()
      await deps.settle(job)
      await deps.repository.finish(job, { ...result, state: result.outcome })
    } catch (failure) {
      await deps.settle(job)
      const code = (failure as { code?: string }).code
      await deps.repository.finish(job, { state: active.signal.aborted && !heartbeatFailure ? "cancelled" : "failed",
        errorCode: code === "ACCESS_REVOKED" || code === "SERVICE_UNAVAILABLE" ? code : "EXECUTION_FAILED", errorMessage: code === "ACCESS_REVOKED" ? "任务执行权限已撤销。" : "任务执行失败。" })
    } finally { clearInterval(timer); await heartbeatWork; controller = undefined }
  }
  return {
    tick(): Promise<void> {
      if (work || stopped) return Promise.resolve()
      work = execute().finally(() => { work = undefined })
      return work
    },
    async stop() { stopped = true; controller?.abort(); await work },
  }
}
