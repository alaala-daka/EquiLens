import "server-only"
import type { Database } from "../database/connection"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { authorizeTaskExecution } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { ResultRepository } from "../results/repository"
import { productionResultValidators } from "../results/registry"
import { ResultService } from "../results/service"
import { executionIdentity } from "../reviews/runtime"
import { registerTaskExecutor } from "../tasks/executors"
import { createBidRequirementsExecutor, createBidVerificationExecutor } from "./executor"
import { createBidRequirementExtractor } from "./extractor"
import { OcrRepository } from "./ocr-repository"
import { VerificationRecordRepository } from "./records-repository"

const state = globalThis as typeof globalThis & { equilensVerificationRuntimeStarted?: boolean }

type Runtime = {
  database: Database
  materials: MaterialRepository
  records: VerificationRecordRepository
  results: ResultService
  fieldSource: OcrRepository
  projects: ProjectRepository
}

async function runtime(): Promise<Runtime> {
  const database = await applicationDatabase()
  return {
    database,
    materials: new MaterialRepository(database),
    records: new VerificationRecordRepository(database),
    results: new ResultService(
      new ResultRepository(database),
      productionResultValidators(),
      // Machine-only kinds and the server-owned requirement-set save path are the
      // same sets used by the results HTTP wiring (Lead integration).
      new Set(["contract-review", "bid-requirements", "bid-verification"]),
      new Set(["bid-requirements"]),
    ),
    fieldSource: new OcrRepository(database),
    projects: new ProjectRepository(database),
  }
}

let cached: Promise<Runtime> | undefined
function loadRuntime(): Promise<Runtime> {
  cached ??= runtime().catch(failure => {
    cached = undefined
    throw failure
  })
  return cached
}

/**
 * C4-VERIFY explicit Node lifecycle entry. `src/instrumentation.ts` must call
 * this before `startTaskRunner()` so bid-requirements/bid-verification tasks are
 * never claimed without their executors. Importing this module starts nothing.
 *
 * `bid-verification` is deterministic (no external request, maxCalls 0). The
 * `bid-requirements` extractor fails honestly when no model is configured; it
 * never saves demo requirements.
 */
export function startVerificationRuntime(): void {
  if (state.equilensVerificationRuntimeStarted) return
  state.equilensVerificationRuntimeStarted = true
  registerTaskExecutor("bid-verification", async (job, context) => {
    const loaded = await loadRuntime()
    return createBidVerificationExecutor({
      repository: loaded.materials,
      records: loaded.records,
      fieldSource: loaded.fieldSource,
      results: loaded.results,
      readProjectRetention: async projectId => (await loaded.projects.findActive(projectId))?.retentionUntil ?? null,
      identityFor: executionIdentity,
      authorize: authorizeTaskExecution,
    })(job, context)
  })
  registerTaskExecutor("bid-requirements", async (job, context) => {
    const loaded = await loadRuntime()
    return createBidRequirementsExecutor({
      repository: loaded.materials,
      results: loaded.results,
      readProjectRetention: async projectId => (await loaded.projects.findActive(projectId))?.retentionUntil ?? null,
      identityFor: executionIdentity,
      authorize: authorizeTaskExecution,
      extractor: createBidRequirementExtractor(),
    })(job, context)
  })
}
