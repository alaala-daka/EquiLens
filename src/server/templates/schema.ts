import type { Database } from "../database/connection"

/**
 * Drafting input storage schema (business migration 0012).
 *
 * Frozen DDL from round-five plan §3. Lead registers this array as migration
 * 0012 and freezes its checksum; do not edit after registration. Only
 * CREATE TABLE / CREATE INDEX: enum and state transitions are validated in the
 * service layer and conditional updates assert exactly one affected row.
 */
export const statements: readonly string[] = [
  "CREATE TABLE equilens_drafting_inputs (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL, current_version_id VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL)",
  "CREATE INDEX equilens_drafting_input_project ON equilens_drafting_inputs(project_id, kind)",
  "CREATE TABLE equilens_drafting_input_versions (id VARCHAR(36) PRIMARY KEY, input_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL, version INTEGER NOT NULL, base_version_id VARCHAR(36) NOT NULL, operation_id VARCHAR(128) NOT NULL, request_hash VARCHAR(64) NOT NULL, sha256 VARCHAR(64) NOT NULL, payload_json TEXT NOT NULL, created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE(project_id, operation_id))",
  "CREATE INDEX equilens_drafting_version_input ON equilens_drafting_input_versions(input_id, version)",
]

/** Test/maintenance helper; production applies the business migration ledger. */
export async function applyDraftingSchema(database: Database): Promise<void> {
  await database.transaction(async connection => {
    for (const statement of statements) await connection.query(statement)
  })
}
