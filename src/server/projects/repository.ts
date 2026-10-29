import { randomUUID } from "node:crypto"
import type { ProjectRole } from "../../lib/business/contracts"
import type { Connection, Database, Row } from "../database/connection"
import { BusinessError } from "./errors"
import type {
  ProjectCreateInput, ProjectMemberView, ProjectRecord, ProjectSource, ProjectStatus, ProjectSummary, ProjectUpdateInput,
} from "./types"
import { projectSummary } from "./types"

const roles: readonly ProjectRole[] = ["admin", "editor", "viewer"]
const sources: readonly ProjectSource[] = ["synthetic", "authorized"]
const statuses: readonly ProjectStatus[] = ["active", "deleted"]

type AccountRow = { id: string; username: string; enabled: boolean }

const projectRecord = (row: Row): ProjectRecord => ({
  id: String(row.id),
  name: String(row.name),
  source: storedSource(row.source),
  sourceReference: String(row.source_reference),
  purpose: String(row.purpose),
  retentionUntil: String(row.retention_until),
  status: storedStatus(row.status),
  createdBy: String(row.created_by),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
  revision: Number(row.revision),
})

const storedRole = (value: unknown): ProjectRole => {
  if (typeof value !== "string" || !roles.includes(value as ProjectRole)) throw new Error("Invalid stored project role")
  return value as ProjectRole
}
const storedSource = (value: unknown): ProjectSource => {
  if (typeof value !== "string" || !sources.includes(value as ProjectSource)) throw new Error("Invalid stored project source")
  return value as ProjectSource
}
const storedStatus = (value: unknown): ProjectStatus => {
  if (typeof value !== "string" || !statuses.includes(value as ProjectStatus)) throw new Error("Invalid stored project status")
  return value as ProjectStatus
}
const duplicate = (failure: unknown) => {
  const value = failure as { code?: string; errcode?: number }
  return value.code === "23505" || value.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY"
    || value.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || value.errcode === 1555 || value.errcode === 2067
}
const notFound = () => new BusinessError("NOT_FOUND", "找不到该项目。")
const memberNotFound = () => new BusinessError("NOT_FOUND", "找不到该成员。")

/**
 * Project and membership storage. Every read/write enters a short transaction;
 * authorization still rechecks the session and membership before calling here.
 */
export class ProjectRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  private timestamp() {
    return this.now().toISOString()
  }

  async create(input: ProjectCreateInput, creator: string): Promise<ProjectRecord> {
    const createdAt = this.timestamp()
    const project: ProjectRecord = {
      id: this.createId(), name: input.name, source: input.source, sourceReference: input.sourceReference,
      purpose: input.purpose, retentionUntil: input.retentionUntil, status: "active", createdBy: creator,
      createdAt, updatedAt: createdAt, deletedAt: null, revision: 1,
    }
    return this.database.transaction(async connection => {
      await connection.query(
        "INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)",
        [project.id, project.name, project.source, project.sourceReference, project.purpose, project.retentionUntil, project.status, creator, createdAt, createdAt, project.revision],
      )
      await connection.query(
        "INSERT INTO equilens_project_members(project_id,account_id,role,granted_by,granted_at,revision) VALUES($1,$2,'admin',$3,$4,1)",
        [project.id, creator, creator, createdAt],
      )
      await this.audit(connection, project.id, creator, "project.create", creator, createdAt)
      return project
    })
  }

  async listFor(accountId: string, superadmin: boolean): Promise<ProjectSummary[]> {
    if (superadmin) {
      const { rows } = await this.database.transaction(connection =>
        connection.query("SELECT * FROM equilens_projects WHERE status='active' ORDER BY created_at DESC, id"))
      return rows.map(row => projectSummary(projectRecord(row), "admin"))
    }
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT p.*, m.role AS member_role FROM equilens_projects p JOIN equilens_project_members m ON m.project_id=p.id WHERE m.account_id=$1 AND p.status='active' ORDER BY p.created_at DESC, p.id", [accountId]))
    return rows.map(row => projectSummary(projectRecord(row), storedRole(row.member_role)))
  }

  async findActive(projectId: string): Promise<ProjectRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_projects WHERE id=$1 AND status='active'", [projectId]))
    return rows.length ? projectRecord(rows[0]) : null
  }

  /** Membership is only meaningful while the project is active; deleted projects deny everyone. */
  async findMember(projectId: string, accountId: string): Promise<ProjectRole | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT m.role FROM equilens_project_members m JOIN equilens_projects p ON p.id=m.project_id WHERE m.project_id=$1 AND m.account_id=$2 AND p.status='active'", [projectId, accountId]))
    return rows.length ? storedRole(rows[0].role) : null
  }

  async members(projectId: string): Promise<ProjectMemberView[]> {
    return this.database.transaction(async connection => {
      await this.assertActiveIn(connection, projectId)
      return this.membersIn(connection, projectId)
    })
  }

  async findAccount(username: string): Promise<AccountRow | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT id,username,enabled FROM equilens_auth_accounts WHERE username=$1", [username]))
    if (!rows.length) return null
    return { id: String(rows[0].id), username: String(rows[0].username), enabled: Number(rows[0].enabled) === 1 }
  }

  async addMember(projectId: string, account: AccountRow, role: ProjectRole, actor: string): Promise<ProjectMemberView> {
    const grantedAt = this.timestamp()
    return this.database.transaction(async connection => {
      await this.assertActiveIn(connection, projectId)
      const stored = (await connection.query("SELECT enabled FROM equilens_auth_accounts WHERE id=$1", [account.id])).rows[0]
      if (!stored) throw new BusinessError("NOT_FOUND", "找不到该账号。")
      if (Number(stored.enabled) !== 1) throw new BusinessError("CONFLICT", "该账号不可用。")
      try {
        await connection.query(
          "INSERT INTO equilens_project_members(project_id,account_id,role,granted_by,granted_at,revision) VALUES($1,$2,$3,$4,$5,1)",
          [projectId, account.id, role, actor, grantedAt],
        )
      } catch (failure) {
        if (duplicate(failure)) throw new BusinessError("CONFLICT", "该账号已是项目成员。")
        throw failure
      }
      await this.audit(connection, projectId, account.id, "member.add", actor, grantedAt)
      return { accountId: account.id, username: account.username, role, grantedAt }
    })
  }

  async changeRole(projectId: string, accountId: string, role: ProjectRole, actor: string): Promise<ProjectMemberView> {
    const changedAt = this.timestamp()
    return this.database.transaction(async connection => {
      await this.lockProjectIn(connection, projectId)
      await this.assertActiveIn(connection, projectId)
      const existing = (await connection.query("SELECT role FROM equilens_project_members WHERE project_id=$1 AND account_id=$2", [projectId, accountId])).rows[0]
      if (!existing) throw memberNotFound()
      const previous = storedRole(existing.role)
      if (previous === role) return this.memberViewIn(connection, projectId, accountId)
      if (previous === "admin") await this.assertOtherAdminIn(connection, projectId, accountId)
      const updated = await connection.query(
        "UPDATE equilens_project_members SET role=$1,revision=revision+1 WHERE project_id=$2 AND account_id=$3 AND role=$4",
        [role, projectId, accountId, previous],
      )
      if (updated.changes !== 1) {
        const current = (await connection.query("SELECT role FROM equilens_project_members WHERE project_id=$1 AND account_id=$2", [projectId, accountId])).rows[0]
        if (current && storedRole(current.role) === role) return this.memberViewIn(connection, projectId, accountId)
        throw new BusinessError("CONFLICT", "成员角色已变化，请刷新后重试。")
      }
      await this.audit(connection, projectId, accountId, "member.update", actor, changedAt)
      return this.memberViewIn(connection, projectId, accountId)
    })
  }

  async removeMember(projectId: string, accountId: string, actor: string): Promise<void> {
    const removedAt = this.timestamp()
    await this.database.transaction(async connection => {
      await this.lockProjectIn(connection, projectId)
      await this.assertActiveIn(connection, projectId)
      const existing = (await connection.query("SELECT role FROM equilens_project_members WHERE project_id=$1 AND account_id=$2", [projectId, accountId])).rows[0]
      if (!existing) return
      const previous = storedRole(existing.role)
      if (previous === "admin") await this.assertOtherAdminIn(connection, projectId, accountId)
      const removed = await connection.query(
        "DELETE FROM equilens_project_members WHERE project_id=$1 AND account_id=$2 AND role=$3",
        [projectId, accountId, previous],
      )
      if (removed.changes !== 1) {
        const current = (await connection.query("SELECT role FROM equilens_project_members WHERE project_id=$1 AND account_id=$2", [projectId, accountId])).rows[0]
        if (!current) return
        throw new BusinessError("CONFLICT", "成员角色已变化，请刷新后重试。")
      }
      await this.audit(connection, projectId, accountId, "member.remove", actor, removedAt)
    })
  }

  async update(projectId: string, update: ProjectUpdateInput, actor: string): Promise<ProjectRecord> {
    const updatedAt = this.timestamp()
    return this.database.transaction(async connection => {
      const current = await this.activeIn(connection, projectId)
      const next: ProjectRecord = {
        ...current,
        name: update.name ?? current.name,
        source: update.source ?? current.source,
        sourceReference: update.sourceReference ?? current.sourceReference,
        purpose: update.purpose ?? current.purpose,
        retentionUntil: update.retentionUntil ?? current.retentionUntil,
        updatedAt,
        revision: current.revision + 1,
      }
      const updated = await connection.query(
        "UPDATE equilens_projects SET name=$1,source=$2,source_reference=$3,purpose=$4,retention_until=$5,updated_at=$6,revision=$7 WHERE id=$8 AND status='active' AND revision=$9",
        [next.name, next.source, next.sourceReference, next.purpose, next.retentionUntil, updatedAt, next.revision, projectId, current.revision],
      )
      if (updated.changes !== 1) {
        await this.activeIn(connection, projectId)
        throw new BusinessError("CONFLICT", "项目信息已变化，请刷新后重试。")
      }
      await this.audit(connection, projectId, actor, "project.update", actor, updatedAt)
      return next
    })
  }

  /** Soft delete revokes access immediately; object/derived cleanup belongs to the lifecycle package. */
  async delete(projectId: string, actor: string): Promise<void> {
    const deletedAt = this.timestamp()
    await this.database.transaction(async connection => {
      const current = await this.activeIn(connection, projectId)
      const deleted = await connection.query(
        "UPDATE equilens_projects SET status='deleted',deleted_at=$1,updated_at=$2,revision=revision+1 WHERE id=$3 AND status='active' AND revision=$4",
        [deletedAt, deletedAt, projectId, current.revision],
      )
      if (deleted.changes !== 1) {
        await this.activeIn(connection, projectId)
        throw new BusinessError("CONFLICT", "项目状态已变化，请刷新后重试。")
      }
      await this.audit(connection, projectId, actor, "project.delete", actor, deletedAt)
    })
  }

  private async activeIn(connection: Connection, projectId: string): Promise<ProjectRecord> {
    const { rows } = await connection.query("SELECT * FROM equilens_projects WHERE id=$1 AND status='active'", [projectId])
    if (!rows.length) throw notFound()
    return projectRecord(rows[0])
  }

  private async assertActiveIn(connection: Connection, projectId: string): Promise<void> {
    await this.activeIn(connection, projectId)
  }

  /**
   * Portable row lock for membership changes: a no-op conditional update is a
   * plain UPDATE on SQLite and takes a row lock on GaussDB, so two concurrent
   * last-admin demotions cannot both pass the admin-count check.
   */
  private async lockProjectIn(connection: Connection, projectId: string): Promise<void> {
    await connection.query("UPDATE equilens_projects SET id=id WHERE id=$1", [projectId])
  }

  private async membersIn(connection: Connection, projectId: string): Promise<ProjectMemberView[]> {
    const { rows } = await connection.query(
      "SELECT m.account_id,m.role,m.granted_at,a.username FROM equilens_project_members m JOIN equilens_auth_accounts a ON a.id=m.account_id WHERE m.project_id=$1 ORDER BY m.granted_at, m.account_id",
      [projectId],
    )
    return rows.map(row => ({ accountId: String(row.account_id), username: String(row.username), role: storedRole(row.role), grantedAt: String(row.granted_at) }))
  }

  private async memberViewIn(connection: Connection, projectId: string, accountId: string): Promise<ProjectMemberView> {
    const { rows } = await connection.query(
      "SELECT m.account_id,m.role,m.granted_at,a.username FROM equilens_project_members m JOIN equilens_auth_accounts a ON a.id=m.account_id WHERE m.project_id=$1 AND m.account_id=$2",
      [projectId, accountId],
    )
    if (!rows.length) throw memberNotFound()
    return { accountId: String(rows[0].account_id), username: String(rows[0].username), role: storedRole(rows[0].role), grantedAt: String(rows[0].granted_at) }
  }

  private async assertOtherAdminIn(connection: Connection, projectId: string, excluded: string): Promise<void> {
    const { rows } = await connection.query(
      "SELECT account_id FROM equilens_project_members WHERE project_id=$1 AND role='admin' AND account_id<>$2",
      [projectId, excluded],
    )
    if (!rows.length) throw new BusinessError("CONFLICT", "项目至少保留一名管理员。")
  }

  private async audit(connection: Connection, projectId: string, accountId: string, action: string, actor: string, createdAt: string): Promise<void> {
    await connection.query(
      "INSERT INTO equilens_project_audit(id,project_id,account_id,action,actor,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [this.createId(), projectId, accountId, action, actor, createdAt],
    )
  }
}
