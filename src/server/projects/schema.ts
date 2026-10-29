import type { Database } from "../database/connection"

/**
 * C1 project schema. The Lead registers these statements as the next
 * business migration; tests apply them directly after the auth migration.
 * Keep every statement idempotent so a repeated explicit application is safe.
 */
export const statements: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS equilens_projects (id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, source VARCHAR(16) NOT NULL, source_reference VARCHAR(500) NOT NULL, purpose VARCHAR(500) NOT NULL, retention_until VARCHAR(10) NOT NULL, status VARCHAR(16) NOT NULL, created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, deleted_at VARCHAR(32), revision INTEGER NOT NULL, FOREIGN KEY (created_by) REFERENCES equilens_auth_accounts(id))",
  "CREATE INDEX IF NOT EXISTS equilens_project_created_by ON equilens_projects(created_by)",
  "CREATE TABLE IF NOT EXISTS equilens_project_members (project_id VARCHAR(36) NOT NULL, account_id VARCHAR(36) NOT NULL, role VARCHAR(16) NOT NULL, granted_by VARCHAR(36) NOT NULL, granted_at VARCHAR(32) NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (project_id, account_id), FOREIGN KEY (project_id) REFERENCES equilens_projects(id), FOREIGN KEY (account_id) REFERENCES equilens_auth_accounts(id))",
  "CREATE INDEX IF NOT EXISTS equilens_project_member_account ON equilens_project_members(account_id)",
  "CREATE TABLE IF NOT EXISTS equilens_project_audit (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, account_id VARCHAR(36) NOT NULL, action VARCHAR(32) NOT NULL, actor VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, FOREIGN KEY (project_id) REFERENCES equilens_projects(id))",
  "CREATE INDEX IF NOT EXISTS equilens_project_audit_project ON equilens_project_audit(project_id, created_at)",
]

/** Test and explicit-maintenance helper; production uses the business migration ledger. */
export async function applyProjectSchema(database: Database): Promise<void> {
  await database.transaction(async connection => {
    for (const statement of statements) await connection.query(statement)
  })
}
