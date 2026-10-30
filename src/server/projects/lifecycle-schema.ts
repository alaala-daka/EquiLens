import type { Database } from "../database/connection"

/**
 * C7 project lifecycle persistence (business migration 0013, registered by the
 * Lead in src/server/database/migrations.ts).
 *
 * Frozen DDL from docs/superpowers/plans/2026-10-29-round-six-plan.md §3.
 * Provider-safe statements only (CREATE TABLE / CREATE INDEX, no CHECK, no
 * partial index, no FK cascade assumption, no CTE/RETURNING): states and
 * transitions are enforced in the service layer and every conditional update
 * asserts exactly one affected row.
 *
 * The project row itself keeps `status ∈ {active, deleted}` forever (0004 is
 * checksum-frozen, never altered); `deleting`/`deleted` are expressed by the
 * deletion record, and a tombstone row prevents an old backup from making a
 * deleted project visible again.
 */

/** Frozen reason set shared by the DB record and the private deletion journal. */
export const projectDeletionReasons = ["user-delete", "retention-expired", "admin-remove"] as const
export type ProjectDeletionReason = (typeof projectDeletionReasons)[number]

/** requested → reclaiming → reclaimed, with `failed` retried from requested/failed. */
export const projectDeletionStates = ["requested", "reclaiming", "reclaimed", "failed"] as const
export type ProjectDeletionState = (typeof projectDeletionStates)[number]

export const projectReclamationStates = ["pending", "cleared"] as const
export type ProjectReclamationState = (typeof projectReclamationStates)[number]

/** Immutable API/DB view of one project deletion record (tombstone row is permanent). */
export type ProjectDeletionRecord = {
  id: string
  projectId: string
  intentId: string
  reason: ProjectDeletionReason
  state: ProjectDeletionState
  requestedBy: string
  requestedAt: string
  retentionUntil: string | null
  attempts: number
  lastError: string | null
  completedAt: string | null
  clearedAt: string | null
}

export function storedDeletionReason(value: unknown): ProjectDeletionReason {
  if (!(projectDeletionReasons as readonly unknown[]).includes(value)) throw new Error("Invalid stored project deletion reason")
  return value as ProjectDeletionReason
}

export function storedDeletionState(value: unknown): ProjectDeletionState {
  if (!(projectDeletionStates as readonly unknown[]).includes(value)) throw new Error("Invalid stored project deletion state")
  return value as ProjectDeletionState
}

/** Row mapper for select * from equilens_project_deletions. */
export function projectDeletionRecord(row: Record<string, unknown>): ProjectDeletionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    intentId: String(row.intent_id),
    reason: storedDeletionReason(row.reason),
    state: storedDeletionState(row.state),
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
    retentionUntil: row.retention_until === null || row.retention_until === undefined ? null : String(row.retention_until),
    attempts: Number(row.attempts),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    clearedAt: row.cleared_at === null || row.cleared_at === undefined ? null : String(row.cleared_at),
  }
}

export const projectDeletionSchemaStatements: readonly string[] = [
  "CREATE TABLE equilens_project_deletions (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, intent_id VARCHAR(36) NOT NULL, reason VARCHAR(32) NOT NULL, state VARCHAR(16) NOT NULL, requested_by VARCHAR(36) NOT NULL, requested_at VARCHAR(32) NOT NULL, retention_until VARCHAR(10), attempts INTEGER NOT NULL, last_error VARCHAR(500), completed_at VARCHAR(32), cleared_at VARCHAR(32), UNIQUE(project_id))",
  "CREATE INDEX equilens_project_deletion_state ON equilens_project_deletions(state, requested_at)",
  "CREATE TABLE equilens_project_reclamations (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, object_key VARCHAR(512) NOT NULL, state VARCHAR(16) NOT NULL, attempts INTEGER NOT NULL, last_error VARCHAR(500), created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, cleared_at VARCHAR(32), UNIQUE(object_key))",
  "CREATE INDEX equilens_project_reclamation_state ON equilens_project_reclamations(project_id, state)",
]

/** Alias kept for the Lead registration import style used by earlier packages. */
export const statements: readonly string[] = projectDeletionSchemaStatements

/**
 * Frozen project-scoped deletion order (children before parents; no FK-cascade
 * dependency). Every table carries `project_id`. Tables listed under
 * `PROJECT_RUNTIME_TABLES` are created by B-line repository `initialize()` calls
 * rather than the migration ledger: they are deleted only when present, and a
 * missing table is recorded instead of failing the whole cleanup.
 */
export const PROJECT_SCOPED_TABLES: readonly string[] = [
  // C4 verification: records → fields → OCR runs
  "equilens_verification_records",
  "equilens_verification_fields",
  "equilens_ocr_runs",
  // C5 drafted content (versions before inputs)
  "equilens_drafting_input_versions",
  "equilens_drafting_inputs",
  // Results/exports: exports → dependencies → reviews → versions → results
  "equilens_result_exports",
  "equilens_result_dependencies",
  "equilens_result_reviews",
  "equilens_result_versions",
  "equilens_results",
  // Tasks/budget: reservations → tasks → project budget
  "equilens_task_budget_reservations",
  "equilens_tasks",
  "equilens_project_budgets",
  // Project documents: versions → documents → write intents
  "equilens_project_document_versions",
  "equilens_project_documents",
  "equilens_project_document_writes",
  // Materials: fragments → snapshots → versions → residue → upload intents → materials
  "equilens_source_fragments",
  "equilens_parse_snapshots",
  "equilens_material_versions",
  "equilens_material_residue",
  "equilens_material_upload_intents",
  "equilens_materials",
  // Membership/audit last; the project row itself is a permanent tombstone.
  "equilens_project_members",
  "equilens_project_audit",
  // B-line runtime tables (created by repository.initialize(), not the ledger).
  "equilens_fact_versions",
  "equilens_payment_ledger_revisions",
  "equilens_evidence_items",
  "equilens_evidence_reports",
]

/** B-line runtime tables; absence is expected and recorded (B line not wired to production). */
export const PROJECT_RUNTIME_TABLES: readonly string[] = [
  "equilens_fact_versions",
  "equilens_payment_ledger_revisions",
  "equilens_evidence_items",
  "equilens_evidence_reports",
]

/**
 * Tables that are intentionally NOT project-scoped. They must never appear with
 * a `project_id` column; the guard test whitelists them so an accidental
 * project-scoped copy fails closed.
 */
export const PROJECT_DELETION_WHITELIST: readonly string[] = [
  // Tombstones/records themselves (kept forever, no content).
  "equilens_projects",
  "equilens_project_deletions",
  "equilens_project_reclamations",
  // Global knowledge/rule publication versions (spec/01 §10.5: not project data).
  "equilens_publications",
  "equilens_publication_versions",
  // Auth accounts/sessions/limits/audit/bootstrap.
  "equilens_auth_accounts",
  "equilens_auth_sessions",
  "equilens_auth_limits",
  "equilens_auth_audit",
  "equilens_auth_bootstrap",
  // Anonymous owner-scoped storage (independent journal, never project data).
  "equilens_documents",
  "equilens_revisions",
  "equilens_document_sessions",
  "equilens_retention_deletions",
  // Anonymous document schema/ledger and global runner singleton.
  "equilens_schema",
  "equilens_business_migrations",
  "equilens_task_runner",
]

/**
 * Test/CLI helper: apply the frozen 0013 statements when the Lead migration
 * registration has not landed yet. It probes the actual table first (applied
 * backups may carry the schema without the ledger row) and skips when present;
 * when the Lead registers 0013 the registered migration remains authoritative.
 */
export async function applyProjectLifecycleSchema(database: Database): Promise<void> {
  try {
    await database.transaction(connection => connection.query("SELECT 1 FROM equilens_project_deletions WHERE 1=0"))
    return
  } catch { /* schema not applied yet */ }
  await database.transaction(async connection => {
    for (const statement of projectDeletionSchemaStatements) await connection.query(statement)
  })
}
