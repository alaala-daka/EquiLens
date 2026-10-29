import type { AuthIdentity } from "@/server/auth/service"

/**
 * C0 shared handoff contracts, frozen 2026-10-28 for the parallel
 * A2/A3 + C1/C2 round. 甲 coordinates; 乙、丙 co-sign.
 *
 * Frozen in this round:
 * - ProjectRef / VersionRef / PublishedRef / MaterialInput / AnalysisManifest
 * - SaveRevision<T>
 * - ProjectRole / ProjectAction / ProjectAccess
 * - BusinessErrorCode
 *
 * Still pending (do not invent compatible duplicates in business modules):
 * - 乙's saveFactRevision / calculateLedger handoff signatures
 * - C2 readMaterialVersion / readParseSnapshot / readSource signatures
 * - A2 editor access interface (owned by A2; C3 consumes the finishe file)
 *
 * This module is types only. It must not contain credentials, database rows,
 * model SDK types, or server-only runtime imports. Changing a frozen field
 * requires Lead approval and updates to every consumer plus its contract test.
 */

export type ProjectRef = { projectId: string }
export type VersionRef = ProjectRef & { id: string; versionId: string }
export type PublishedRef = { id: string; versionId: string; sha256: string }

export type MaterialInput = {
  document: VersionRef
  parseSnapshotId: string
  sha256: string
}

export type AnalysisManifest = ProjectRef & {
  materials: MaterialInput[]
  facts: VersionRef[]
  ledger: VersionRef | null
  upstreamResults: VersionRef[]
  rules: PublishedRef[]
  knowledge: PublishedRef[]
  templates: PublishedRef[]
}

export type SaveRevision<T> = {
  baseVersionId: string
  operationId: string
  value: T
  reason: string
}

export type ProjectRole = "admin" | "editor" | "viewer"
export type ProjectAction = "read" | "edit" | "manage"

/**
 * Fresh project authorization result. `identity` is a snapshot for later
 * revalidation only and is never an authorization cache; every resource
 * access rechecks the current session and membership.
 */
export type ProjectAccess = ProjectRef & {
  action: ProjectAction
  role: ProjectRole
  identity: AuthIdentity
}

/** Session-independent authorization snapshot; recheck before every stage. */
export type ProjectExecutionAccess = ProjectRef & {
  action: ProjectAction
  role: ProjectRole
  account: { id: string; username: string; role: "member" | "superadmin" }
}

export type ResultRevisionRef = ProjectRef & {
  resultId: string
  versionId: string
  sha256: string
}

/** Project contract-review task input frozen for round three (catalog is the runtime authority). */
export type ProjectReviewScene = "auto" | "mep-sub-2026" | "decoration-sub-2026" | "curtain-wall-sub-2026" | "steel-structure-sub-2026"

export type ProjectReviewConditions = {
  asOf?: string
  scene: ProjectReviewScene
  role: "专业分包人"
  region: string
  externalProcessingConsent: true
  unreviewedMaterialsConsent: boolean
}

export type ProjectReviewMaterialRef = { materialVersionId: string; sha256: string }

export type ProjectReviewSubmission = ProjectRef & {
  materials: ProjectReviewMaterialRef[]
  conditions: ProjectReviewConditions
}

export type ResultValidation = {
  status: "valid" | "invalid" | "partial"
  versionId: string
  checkedAt: string
  issues: Array<{ code: string; message: string; ref?: string }>
}

export type ResultReview = {
  versionId: string
  decision: "approved" | "rejected" | "changes_requested"
  comment: string
  reviewedBy: string
  reviewedAt: string
}

export type ExportRef = ResultRevisionRef & {
  exportId: string
  format: "docx"
  createdAt: string
}

/**
 * Fixed business error classes for HTTP adapters. Authentication-specific
 * codes stay in src/server/auth/errors.ts; adapters must not leak SQL,
 * credentials, or material text through any of these codes.
 */
export type BusinessErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "INVALID_SOURCE"
  | "SERVICE_UNAVAILABLE"
