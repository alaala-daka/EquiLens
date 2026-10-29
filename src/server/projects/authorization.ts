import type { ProjectAccess, ProjectAction, ProjectRole } from "../../lib/business/contracts"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "./errors"
import type { ProjectRepository } from "./repository"
import { isProjectId } from "./validation"

/** Capability matrix owned by C1: read is shared, edit excludes viewers, manage is admin-only. */
export function roleAllows(role: ProjectRole, action: ProjectAction): boolean {
  if (action === "read") return true
  if (action === "edit") return role === "admin" || role === "editor"
  return role === "admin"
}

export type ProjectAuthorizationDependencies = {
  repository: Pick<ProjectRepository, "findActive" | "findMember">
  /** Production wiring is src/server/auth/access.ts revalidateAccountSession. */
  revalidateSession: (sessionId: string) => Promise<AuthIdentity>
}

export type ProjectAuthorization = ReturnType<typeof createProjectAuthorization>

/**
 * Fresh project authorization. The returned ProjectAccess.identity is a
 * snapshot for later revalidation only; it is never an authorization cache.
 */
export function createProjectAuthorization(deps: ProjectAuthorizationDependencies) {
  async function revalidate(identity: AuthIdentity): Promise<AuthIdentity> {
    let current: AuthIdentity
    try {
      current = await deps.revalidateSession(identity.session.id)
    } catch (failure) {
      throw sessionFailure(failure)
    }
    if (current.account.id !== identity.account.id) throw new BusinessError("UNAUTHENTICATED", "请先登录。")
    return current
  }

  return {
    revalidate,

    async requireProjectAccess(identity: AuthIdentity, projectId: string, action: ProjectAction): Promise<ProjectAccess> {
      const current = await revalidate(identity)
      if (current.account.role === "superadmin") {
        // The global exception still requires a real, non-deleted project.
        if (!isProjectId(projectId)) throw new BusinessError("NOT_FOUND", "找不到该项目。")
        if (!await deps.repository.findActive(projectId)) throw new BusinessError("NOT_FOUND", "找不到该项目。")
        return { projectId, action, role: "admin", identity: current }
      }
      // Non-members and unknown ids share one refusal so project existence does not leak.
      if (!isProjectId(projectId)) throw new BusinessError("FORBIDDEN", "无权访问该项目。")
      const role = await deps.repository.findMember(projectId, current.account.id)
      if (!role || !roleAllows(role, action)) throw new BusinessError("FORBIDDEN", "无权访问该项目。")
      return { projectId, action, role, identity: current }
    },
  }
}

function sessionFailure(failure: unknown): BusinessError {
  if (failure instanceof BusinessError) return failure
  if (isAuthError(failure)) {
    if (failure.code === "UNAUTHENTICATED") return new BusinessError("UNAUTHENTICATED", "请先登录。")
    if (failure.code === "FORBIDDEN") return new BusinessError("FORBIDDEN", "无权访问该项目。")
  }
  // Database/readiness failures must not be disguised as a signed-out user.
  return new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。")
}
