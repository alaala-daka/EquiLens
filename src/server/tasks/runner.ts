import "server-only"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { reviewTaskRepository } from "../contract-review/tasks/service"
import { runClaimedReview } from "../contract-review/tasks/workflow"
import { authorizeTaskExecution } from "../projects/access"
import { createUnifiedRunner, type TaskExecutor } from "./runner-core"
import { taskExecutorRegistry } from "./executors"
import { reservePaidCall, settleOutstandingBudget, settlePaidCall, taskRepository } from "./service"
export type { TaskExecutionResult, TaskExecutor } from "./runner-core"
export type TaskExecutorRegistry = { get(kind: import("./catalog").TaskKind): TaskExecutor | null; available(): import("./catalog").TaskKind[] }
type Core = ReturnType<typeof createUnifiedRunner>
type State = { started: boolean; core?: Core; ticking?: Promise<void>; timer?: ReturnType<typeof setTimeout>; review?: { id: string; controller: AbortController } }
const global = globalThis as typeof globalThis & { equilensUnifiedTaskRunner?: State }
const state = () => global.equilensUnifiedTaskRunner ??= { started: false }
async function tick() {
  const current = state()
  if (!current.started || current.ticking) return
  current.ticking = (async () => {
    current.core ??= createUnifiedRunner({
      repository: await taskRepository(), executor: taskExecutorRegistry.get,
      authorize: async job => { await authorizeTaskExecution({ accountId: job.owner, projectId: job.projectId, action: "edit" }) },
      review: async () => {
        const job = await (await reviewTaskRepository()).claim()
        if (job) await runClaimedReview(job, { onActive: controller => {
          current.review = controller ? { id: job.id, controller } : undefined
          if (controller && !current.started) controller.abort(new ReviewError("REVIEW_CANCELLED"))
        } })
      }, reserve: reservePaidCall, settle: settleOutstandingBudget, settleCall: settlePaidCall,
    })
    if (current.started) await current.core.tick()
  })().catch(() => { console.error("Task runner unavailable") }).finally(() => {
    current.ticking = undefined
    if (current.started) {
      current.timer = setTimeout(() => { void tick() }, 2000)
      current.timer.unref()
    }
  })
  await current.ticking
}
export function startTaskRunner() { if (state().started) return; state().started = true; void tick() }
export function wakeTaskRunner() { if (!state().started || state().ticking) return; clearTimeout(state().timer); void tick() }
export function cancelRunningReview(id: string) { if (state().review?.id === id) state().review?.controller.abort(new ReviewError("REVIEW_CANCELLED")) }
export async function stopTaskRunner() {
  state().started = false
  clearTimeout(state().timer)
  state().review?.controller.abort(new ReviewError("REVIEW_CANCELLED"))
  await state().core?.stop()
  await state().ticking
  state().core = undefined
}
