import { createHash } from "node:crypto"
import { statements as materialStatements } from "../materials/schema"
import { statements as projectStatements } from "../projects/schema"
import { statements as taskStatements } from "../tasks/schema"
import { statements as resultStatements } from "../results/schema"
import { statements as verificationStatements } from "../verification/schema"
import { statements as knowledgeStatements } from "../knowledge/schema"
import { statements as draftingStatements } from "../templates/schema"
import { statements as projectLifecycleStatements } from "../projects/lifecycle-schema"
import { uploadIntentStatements } from "../materials/schema"
import { documentStatements } from "../materials/document-schema"
import type { Database } from "./connection"

const factStatements = [
  "CREATE TABLE equilens_fact_versions (id VARCHAR(36) PRIMARY KEY, fact_id VARCHAR(36) NOT NULL, project_id VARCHAR(64) NOT NULL, contract_id VARCHAR(64), version INTEGER NOT NULL, supersedes_version_id VARCHAR(36), operation_id VARCHAR(128) NOT NULL, request_hash VARCHAR(64) NOT NULL, sha256 VARCHAR(64) NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(fact_id, version), UNIQUE(project_id, operation_id))",
  "CREATE INDEX equilens_fact_version_project ON equilens_fact_versions(project_id, contract_id, fact_id, version)",
] as const

export type BusinessMigration = { id: string; statements: readonly string[] }
export const businessMigrations: readonly BusinessMigration[] = [{ id: "0001", statements: [
  "CREATE TABLE equilens_auth_accounts (id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, password_hash TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL)",
  "CREATE TABLE equilens_auth_sessions (token_hash VARCHAR(64) PRIMARY KEY, account_id VARCHAR(36) NOT NULL, expires_at BIGINT NOT NULL, FOREIGN KEY (account_id) REFERENCES equilens_auth_accounts(id))",
  "CREATE INDEX equilens_auth_session_account ON equilens_auth_sessions(account_id)",
  "CREATE TABLE equilens_auth_limits (limit_key VARCHAR(64) PRIMARY KEY, window_start BIGINT NOT NULL, attempts INTEGER NOT NULL)",
  "CREATE TABLE equilens_auth_audit (id VARCHAR(36) PRIMARY KEY, account_id VARCHAR(36) NOT NULL, action VARCHAR(16) NOT NULL, actor VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL)",
] }, { id: "0002", statements: [
  "CREATE INDEX equilens_auth_session_expiry ON equilens_auth_sessions(expires_at)",
  "CREATE INDEX equilens_auth_limit_window ON equilens_auth_limits(window_start)",
] }, { id: "0003", statements: [
  "ALTER TABLE equilens_auth_accounts ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'member'",
  "CREATE TABLE equilens_auth_bootstrap (id INTEGER PRIMARY KEY)",
] }, { id: "0004", statements: projectStatements }, { id: "0005", statements: taskStatements }, { id: "0006", statements: materialStatements }, { id: "0007", statements: resultStatements }, { id: "0008", statements: uploadIntentStatements }, { id: "0009", statements: documentStatements }, { id: "0010", statements: verificationStatements }, { id: "0011", statements: knowledgeStatements }, { id: "0012", statements: draftingStatements }, { id: "0013", statements: projectLifecycleStatements }, { id: "0014", statements: factStatements }]

/** Explicit initialization only; never runs on module import. */
export async function migrateBusiness(db: Database, migrations = businessMigrations) {
  migrations.forEach((migration, index) => {
    if (migration.id !== String(index + 1).padStart(4, "0") || !migration.statements.length) throw new Error("Invalid business migration sequence")
  })
  await db.transaction(async connection => {
    await connection.query("CREATE TABLE IF NOT EXISTS equilens_business_migrations (id VARCHAR(4) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at TEXT NOT NULL)")
    const { rows } = await connection.query("SELECT id, checksum FROM equilens_business_migrations ORDER BY id")
    for (let index = 0; index < rows.length; index++) {
      const migration = migrations[index]
      if (!migration || rows[index].id !== migration.id || rows[index].checksum !== checksum(migration)) throw new Error("Business migration history mismatch")
    }
    for (const migration of migrations.slice(rows.length)) {
      for (const statement of migration.statements) await connection.query(statement)
      await connection.query("INSERT INTO equilens_business_migrations(id,checksum,applied_at) VALUES ($1,$2,$3)", [migration.id, checksum(migration), new Date().toISOString()])
    }
  })
}
function checksum(migration: BusinessMigration) {
  return createHash("sha256").update(JSON.stringify(migration)).digest("hex")
}
