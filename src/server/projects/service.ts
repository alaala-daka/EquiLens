import type { ProjectRole } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import type { ProjectAuthorization } from "./authorization"
import { BusinessError } from "./errors"
import type { ProjectRepository } from "./repository"
import type {
  ProjectList, ProjectMemberView, ProjectSummary,
} from "./types"
import { projectSummary } from "./types"
import { parseProjectCreate, parseProjectMember, parseProjectRole, parseProjectUpdate } from "./validation"

export type ProjectServiceDependencies = {
  repository: ProjectRepository
  authorization: ProjectAuthorization
  now?: () => Date
}

/**
 * Business entry points for project HTTP adapters. Every method either
 * revalidates the session (list/create) or calls requireProjectAccess first;
 * the HTTP layer additionally authenticates the cookie before calling here.
 */
export class ProjectService {
  private readonly now: () => Date

  constructor(private readonly deps: ProjectServiceDependencies) {
    this.now = deps.now ?? (() => new Date())
  }

  async list(identity: AuthIdentity): Promise<ProjectList> {
    const current = await this.deps.authorization.revalidate(identity)
    const projects = await this.deps.repository.listFor(current.account.id, current.account.role === "superadmin")
    return { projects, canCreateProject: true }
  }

  async create(identity: AuthIdentity, body: unknown): Promise<ProjectSummary> {
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
    const access = await this.deps.authorization.requireProjectAccess(identity, projectId, "manage")
    await this.deps.repository.delete(projectId, access.identity.account.id)
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
