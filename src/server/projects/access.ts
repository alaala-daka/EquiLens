import "server-only"
import type { ProjectAccess, ProjectAction } from "../../lib/business/contracts"
import { requireAccount, revalidateAccountSession } from "../auth/access"
import { authConfig } from "../auth/config"
import type { AuthIdentity } from "../auth/service"
import { applicationDatabase } from "../database/runtime"
import { createProjectAuthorization, type ProjectAuthorization } from "./authorization"
import type { ProjectHttpDependencies } from "./handlers"
import { requestProjectDeletion, requireProjectLifecycleReady } from "./lifecycle"
import { ProjectRepository } from "./repository"
import { ProjectService } from "./service"
import { AuthService } from "../auth/service"
import { createTaskExecutionAuthorization } from "./authorization"

/**
 * C7: every project-data entry fails closed with 503 until the lifecycle
 * runtime has replayed the deletion journal and reconciled deletion records.
 * The gate lives here (single place) rather than in each materials/results/
 * exports/verification adapter.
 */
export async function authorizeTaskExecution(input: { accountId: string; projectId: string; action: ProjectAction }) {
  const database = await applicationDatabase()
  const auth = new AuthService(database)
  return createTaskExecutionAuthorization({
    repository: new ProjectRepository(database),
    account: id => auth.account(id),
    ready: requireProjectLifecycleReady,
  }).authorize(input)
}

type ProjectRuntime = { deps: ProjectHttpDependencies; authorization: ProjectAuthorization }

/**
 * Server-only production wiring. Routes enter through this module, and A3/B2
 * call requireProjectAccess for guarded task/export entry points. Tests build
 * the same handlers with an injected SQLite repository and auth access instance.
 */
async function load(): Promise<ProjectRuntime> {
  const database = await applicationDatabase()
  const repository = new ProjectRepository(database)
  const authorization = createProjectAuthorization({
    repository,
    revalidateSession: revalidateAccountSession,
    ready: requireProjectLifecycleReady,
  })
  return {
    authorization,
    deps: {
      requireAccount,
      service: new ProjectService({
        repository,
        authorization,
        ready: requireProjectLifecycleReady,
        deletion: { request: input => requestProjectDeletion(input) },
      }),
      origin: () => authConfig(process.env).origin,
    },
  }
}

let cached: Promise<ProjectRuntime> | undefined

function runtime(): Promise<ProjectRuntime> {
  cached ??= load().catch(failure => {
    cached = undefined
    throw failure
  })
  return cached
}

export function projectHttpServices(): Promise<ProjectHttpDependencies> {
  return runtime().then(value => value.deps)
}

/** Fresh guard for server callers (tasks, exports, materials). Rechecks session and membership. */
export async function requireProjectAccess(identity: AuthIdentity, projectId: string, action: ProjectAction): Promise<ProjectAccess> {
  return (await runtime()).authorization.requireProjectAccess(identity, projectId, action)
}

/** Revalidate a session snapshot without checking any project (for list/create style work). */
export async function revalidateProjectIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
  return (await runtime()).authorization.revalidate(identity)
}
