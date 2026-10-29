import "server-only"
import type { AuthIdentity } from "../auth/service"
import { applicationDatabase } from "../database/runtime"
import { loadPublishedRulePack } from "../knowledge/resolver"
import { KnowledgeRepository } from "../knowledge/repository"
import { MaterialRepository } from "../materials/repository"
import { authorizeTaskExecution } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { ResultRepository } from "../results/repository"
import { productionResultValidators } from "../results/registry"
import { ResultService } from "../results/service"
import { privateObjectStoreRuntime } from "../storage/runtime"
import { createProjectReviewExecutor } from "./executor"
import { registerProjectReviewExecutor } from "./registration"
import { createProjectReviewRunner } from "./runner"

const state = globalThis as typeof globalThis & { equilensReviewRuntimeStarted?: boolean }

/**
 * Server-side execution identity snapshot for the result writer.
 *
 * ResultService never treats this identity as authorization: every result
 * access re-enters the injected authorizer, which reads the current account and
 * project membership (no session is created or renewed by a task).
 */
export function executionIdentity(accountId: string): AuthIdentity {
  return { account: { id: accountId, username: "", role: "member" }, session: { id: "", expiresAt: 0 } }
}

/**
 * Production review runner. The pinned published pack loader (C6) reads the
 * immutable publication version from the business database; the debug path keeps
 * loading the deployed scene bundles from files.
 */
function productionReviewRunner(repository: KnowledgeRepository) {
  return createProjectReviewRunner({
    loadPublishedPack: async ref => loadPublishedRulePack(repository, ref),
  })
}

async function projectReviewExecutor() {
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return createProjectReviewExecutor({
    repository: new MaterialRepository(database),
    store: privateObjectStoreRuntime(),
    readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null,
    results: new ResultService(new ResultRepository(database), productionResultValidators()),
    runner: productionReviewRunner(new KnowledgeRepository(database)),
    identityFor: executionIdentity,
    authorize: authorizeTaskExecution,
  })
}

/**
 * A4c explicit Node lifecycle entry. src/instrumentation.ts must call this
 * before startTaskRunner() so a queued contract-review task is never claimed
 * without its executor. Importing this module starts nothing.
 */
export function startReviewRuntime(): void {
  if (state.equilensReviewRuntimeStarted) return
  state.equilensReviewRuntimeStarted = true
  registerProjectReviewExecutor(projectReviewExecutor)
}
