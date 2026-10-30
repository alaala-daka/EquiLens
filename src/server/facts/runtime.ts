import "server-only"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { authorizeTaskExecution } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { resultHttpServices } from "../results/access"
import { executionIdentity } from "../reviews/runtime"
import { privateObjectStoreRuntime } from "../storage/runtime"
import { registerTaskExecutor } from "../tasks/executors"
import { createFactsExecutor } from "./executor"
import { createFactExtractor } from "./extractor"
import { longRunningModelFetch } from "../ai/dispatcher"

const state = globalThis as typeof globalThis & { equilensFactsRuntimeStarted?: boolean }
/** Explicit Node lifecycle hook; importing this module performs no work. */
export function startFactsRuntime(): void {
  if (state.equilensFactsRuntimeStarted) return
  state.equilensFactsRuntimeStarted = true
  registerTaskExecutor("document-analysis", async (job, context) => {
    const database = await applicationDatabase()
    const projects = new ProjectRepository(database)
    return createFactsExecutor({ repository: new MaterialRepository(database), store: privateObjectStoreRuntime(), results: (await resultHttpServices()).service,
      readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null, identityFor: executionIdentity, authorize: authorizeTaskExecution, extractor: createFactExtractor(longRunningModelFetch()) })(job, context)
  })
}
