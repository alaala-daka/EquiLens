import type { TaskExecutor } from "../tasks/runner-core"
import { registerTaskExecutor, taskExecutorRegistry } from "../tasks/executors"

/** The review executor is registered only by the explicit Node lifecycle. */
export function projectReviewExecutorRegistered(): boolean {
  return taskExecutorRegistry.get("contract-review") !== null
}

/**
 * A4c registration seam (testable without the server-only runtime).
 *
 * `src/server/reviews/runtime.ts` calls this exactly once from
 * `startReviewRuntime()` in the Node instrumentation lifecycle. The factory is
 * invoked per claimed task, so no database, object store or rule pack is
 * touched at import/build time. A second registration is a no-op and can never
 * replace the production executor with a test double.
 */
export function registerProjectReviewExecutor(factory: () => TaskExecutor | Promise<TaskExecutor>): void {
  if (projectReviewExecutorRegistered()) return
  registerTaskExecutor("contract-review", async (job, context) => (await factory())(job, context))
}
