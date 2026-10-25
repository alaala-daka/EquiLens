import "server-only"
import { ReviewError } from "../../../../tools/contract-review/src/errors"
import { reviewTaskRepository } from "./service"
import type { ClaimedReview } from "./repository"
import { runClaimedReview } from "./workflow"

type Runner = { started: boolean; ticking: boolean; timer?: ReturnType<typeof setTimeout>; active?: { id: string; controller: AbortController }; work?: Promise<void> }
const global = globalThis as typeof globalThis & { equilensReviewRunner?: Runner }
function state(): Runner { return global.equilensReviewRunner ??= { started: false, ticking: false } }

async function execute(job: ClaimedReview) {
  await runClaimedReview(job, { onActive: controller => {
    if (controller) state().active = { id: job.id, controller }
    else if (state().active?.id === job.id) state().active = undefined
  } })
}
async function tick() {
  const current = state()
  if (!current.started || current.ticking) return
  current.ticking = true
  try {
    const job = await (await reviewTaskRepository()).claim()
    if (job) await execute(job)
  } catch { console.error("Contract review task runner unavailable") }
  finally {
    current.ticking = false
    if (current.started) {
      current.timer = setTimeout(() => { current.work = tick() }, 2000)
      current.timer.unref()
    }
  }
}
/** 仅由 instrumentation 的 Node.js 生命周期显式调用。 */
export function startReviewRunner() {
  const current = state()
  if (current.started) return
  current.started = true
  current.work = tick()
}
export function wakeReviewRunner() {
  const current = state()
  if (!current.started || current.ticking) return
  clearTimeout(current.timer)
  current.work = tick()
}
export function cancelRunningReview(id: string) {
  if (state().active?.id === id) state().active?.controller.abort(new ReviewError("REVIEW_CANCELLED"))
}
export async function stopReviewRunner() {
  const current = state()
  current.started = false
  clearTimeout(current.timer)
  current.active?.controller.abort(new ReviewError("REVIEW_CANCELLED"))
  await current.work
}
