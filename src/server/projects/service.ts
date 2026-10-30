import type { ProjectRole } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import type { ProjectAuthorization } from "./authorization"
import { BusinessError } from "./errors"
import type { ProjectDeletionReason, ProjectDeletionRecord } from "./lifecycle-schema"
import type { ProjectRepository } from "./repository"
import type {
  ProjectList, ProjectMemberView, ProjectSummary,
} from "./types"
import { projectSummary } from "./types"
import { parseProjectCreate, parseProjectMember, parseProjectRole, parseProjectUpdate } from "./validation"

/** Minimal HTTP-facing deletion port implemented by the lifecycle runtime. */
export type ProjectDeletionPort = {
  request(input: { projectId: string; actor: string; reason: ProjectDeletionReason }): Promise<ProjectDeletionRecord>
}

export type DeletionStatusView = {
  state: ProjectDeletionRecord["state"]
  requestedAt: string
  attempts: number
  completedAt: string | null
  clearedAt: string | null
}

export type ProjectServiceDependencies = {
  repository: ProjectRepository
  authorization: ProjectAuthorization
  now?: () => Date
  /** C7 lifecycle readiness gate (production wiring); omitted by direct-injection tests. */
  ready?: () => void
  /** C7 deletion takeover: revoke access + durable journal in one HTTP request. */
  deletion?: ProjectDeletionPort
}

/**
 * Business entry points for project HTTP adapters. Every method either
 * revalidates the session (list/create) or calls requireProjectAccess first;
 * the HTTP layer additionally authenticates the cookie before calling here.
 *
 * C7: `remove` revokes access and records the deletion in the same database
 * transaction, then appends the durable private-deletion-journal intent (the
 * lifecycle runtime performs object/row reclamation). Deletion status remains
 * observable after the project is gone through `GET /deletion` with the frozen
 * role matrix; it never exposes project content.
 */
export class ProjectService {
  private readonly now: () => Date

  constructor(private readonly deps: ProjectServiceDependencies) {
    this.now = deps.now ?? (() => new Date())
  }

  private gate(): void {
    this.deps.ready?.()
  }

  async list(identity: AuthIdentity): Promise<ProjectList> {
    this.gate()
    const current = await this.deps.authorization.revalidate(identity)
    const projects = await this.deps.repository.listFor(current.account.id, current.account.role === "superadmin")
    return { projects, canCreateProject: true }
  }

  async create(identity: AuthIdentity, body: unknown): Promise<ProjectSummary> {
    this.gate()
    const current = await this.deps.authorization.revalidate(identity)
    const input = parseProjectCreate(body, this.now())
    const project = await this.deps.repository.create(input, current.account.id)
    return projectSummary(project, "admin")
  }

  async detail(identity: AuthIdentity, projectId: string): Promise<ProjectSummary> {
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "read")
    return this.summary(projectId, access.role)
  }

  async update(identity: AuthIdentity, projectId: string, body: unknown): Promise<ProjectSummary> {
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    const update = parseProjectUpdate(body, this.now())
    const project = await this.deps.repository.update(projectId, update, access.identity.account.id)
    return projectSummary(project, access.role)
  }

  async remove(identity: AuthIdentity, projectId: string): Promise<void> {
    this.gate()
    let actor: string
    try {
      const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
      actor = access.identity.account.id
    } catch (failure) {
      // Repeated DELETE / interrupted retry: the recorded requester and current
      // superadmins may finish the same idempotent request even though the
      // project is already invisible to the normal guard.
      if (!(failure instanceof BusinessError) || (failure.code !== "FORBIDDEN" && failure.code !== "NOT_FOUND")) throw failure
      const current = await this.deps.authorization.revalidate(identity)
      const record = await this.deps.repository.deletionRecord(projectId)
      if (!record) throw failure
      if (current.account.role !== "superadmin" && record.requestedBy !== current.account.id) throw failure
      actor = current.account.id
      if (!this.deps.deletion) return
      await this.deps.deletion.request({ projectId, actor, reason: "user-delete" })
      return
    }
    if (!this.deps.deletion) {
      await this.deps.repository.delete(projectId, actor, "user-delete")
      return
    }
    await this.deps.deletion.request({ projectId, actor, reason: "user-delete" })
  }

  /**
   * Deletion observability after access revocation. Allowed for the recorded
   * requester and superadmins forever; other current project admins only while
   * their membership rows survive; everyone else gets the uniform 404. Only
   * state/attempts/timestamps are returned — never project content.
   */
  async deletionState(identity: AuthIdentity, projectId: string): Promise<DeletionStatusView> {
    this.gate()
    const current = await this.deps.authorization.revalidate(identity)
    const record = await this.deps.repository.deletionRecord(projectId)
    if (!record) throw new BusinessError("NOT_FOUND", "找不到该删除记录。")
    const allowed = current.account.role === "superadmin" ||
      record.requestedBy === current.account.id ||
      (await this.deps.repository.deletionMemberRole(projectId, current.account.id)) === "admin"
    if (!allowed) throw new BusinessError("NOT_FOUND", "找不到该删除记录。")
    return {
      state: record.state,
      requestedAt: record.requestedAt,
      attempts: record.attempts,
      completedAt: record.completedAt,
      clearedAt: record.clearedAt,
    }
  }

  async members(identity: AuthIdentity, projectId: string): Promise<ProjectMemberView[]> {
    // Member names are membership-management data; viewers cannot enumerate them.
    await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    return this.deps.repository.members(projectId)
  }

  async addMember(identity: AuthIdentity, projectId: string, body: unknown): Promise<ProjectMemberView> {
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    const input = parseProjectMember(body)
    const account = await this.deps.repository.findAccount(input.username)
    if (!account) throw new BusinessError("NOT_FOUND", "找不到该账号。")
    if (!account.enabled) throw new BusinessError("CONFLICT", "该账号不可用。")
    return this.deps.repository.addMember(projectId, account, input.role, access.identity.account.id)
  }

  async changeRole(identity: AuthIdentity, projectId: string, accountId: string, body: unknown): Promise<ProjectMemberView> {
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    return this.deps.repository.changeRole(projectId, accountId, parseProjectRole(body), access.identity.account.id)
  }

  async removeMember(identity: AuthIdentity, projectId: string, accountId: string): Promise<void> {
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    await this.deps.repository.removeMember(projectId, accountId, access.identity.account.id)
  }

  private async summary(projectId: string, role: ProjectRole): Promise<ProjectSummary> {
    const project = await this.deps.repository.findActive(projectId)
    if (!project) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    return projectSummary(project, role)
  }
}
