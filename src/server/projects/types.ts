import type { ProjectRole } from "../../lib/business/contracts"

export type ProjectSource = "synthetic" | "authorized"
export type ProjectStatus = "active" | "deleted"

/** Immutable database row view; never returned directly by HTTP handlers. */
export type ProjectRecord = {
  id: string
  name: string
  source: ProjectSource
  sourceReference: string
  purpose: string
  retentionUntil: string
  status: ProjectStatus
  createdBy: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
}

export type ProjectSummary = {
  id: string
  name: string
  source: ProjectSource
  purpose: string
  retentionUntil: string
  role: ProjectRole
  createdAt: string
  updatedAt: string
}

export type ProjectMemberView = { accountId: string; username: string; role: ProjectRole; grantedAt: string }

export type ProjectCreateInput = {
  name: string
  source: ProjectSource
  sourceReference: string
  purpose: string
  retentionUntil: string
}

export type ProjectUpdateInput = Partial<ProjectCreateInput>

export type ProjectMemberInput = { username: string; role: ProjectRole }

export type ProjectList = { projects: ProjectSummary[]; canCreateProject: boolean }

export function projectSummary(project: ProjectRecord, role: ProjectRole): ProjectSummary {
  return {
    id: project.id, name: project.name, source: project.source, purpose: project.purpose,
    retentionUntil: project.retentionUntil, role, createdAt: project.createdAt, updatedAt: project.updatedAt,
  }
}
