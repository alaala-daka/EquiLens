import type { ProjectRecord } from "./types"

/**
 * C7 project retention semantics (per-request enforcement lives in
 * repository/authorization; this module owns the frozen clock rule and the
 * sweep candidate selection).
 *
 * Exact rule: `retention_until` is a date (YYYY-MM-DD) on the Asia/Shanghai
 * calendar. A project is expired once `now >= start of (retention_until + 1 day)
 * at UTC+08:00` — i.e. the whole retention day is inclusive and the project is
 * expired from the next Shanghai midnight. This matches the project creation
 * validator's Asia/Shanghai "today" comparison and never depends on the
 * hourly sweep having run.
 *
 * Only `source='authorized'` projects expire automatically. Synthetic demo
 * projects are retained until the owner explicitly deletes them (archive is not
 * delivered this round), so they never expire through this rule.
 */
const shanghaiOffsetMs = 8 * 3600_000
const dayMs = 86_400_000

const dayPattern = /^\d{4}-\d{2}-\d{2}$/

export function projectRetentionBoundary(retentionUntil: string): number {
  if (!dayPattern.test(retentionUntil)) throw new Error("Invalid project retention date")
  const start = Date.parse(`${retentionUntil}T00:00:00Z`)
  if (!Number.isFinite(start)) throw new Error("Invalid project retention date")
  // Shanghai wall-clock start of the retention day plus one day = exclusive expiry instant.
  return start - shanghaiOffsetMs + dayMs
}

/** True when an authorized project with this retention date is expired at `now`. */
export function projectRetentionExpired(retentionUntil: string, now: Date): boolean {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new Error("Invalid lifecycle clock")
  return timestamp >= projectRetentionBoundary(retentionUntil)
}

/**
 * Derived access state: expired authorized projects are treated as absent for
 * every content request, independent of `status` and of the cleanup sweep.
 */
export function projectDataExpired(project: Pick<ProjectRecord, "source" | "retentionUntil">, now: Date): boolean {
  if (project.source === "synthetic") return false
  return projectRetentionExpired(project.retentionUntil, now)
}

/** Single sweep clock snapshot; callers pass one `now` to all candidate decisions. */
export function expiredAuthorizedProjects(projects: ProjectRecord[], now: Date): ProjectRecord[] {
  return projects.filter(project => project.status === "active" && projectDataExpired(project, now))
}

/** Project-scoped list exclusion for directly constructed summaries (defense in depth). */
export function visibleToCaller(project: Pick<ProjectRecord, "status" | "source" | "retentionUntil">, now: Date): boolean {
  return project.status === "active" && !projectDataExpired(project, now)
}
