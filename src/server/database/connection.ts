import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createRequire } from "node:module"
import type { SQLInputValue } from "node:sqlite"
import { databaseConfig } from "./config"

export type Row = Record<string, unknown>
export type Connection = { query(sql: string, values?: (string | number | null)[]): Promise<{ rows: Row[]; changes: number }> }
export type Database = { transaction<T>(work: (connection: Connection) => Promise<T>): Promise<T>; close(): Promise<void> }

const schema = [
  "CREATE TABLE IF NOT EXISTS equilens_schema (version INTEGER PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS equilens_documents (owner VARCHAR(64) NOT NULL, id VARCHAR(36) NOT NULL, current_revision VARCHAR(36) NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY (owner, id))",
  "CREATE TABLE IF NOT EXISTS equilens_revisions (owner VARCHAR(64) NOT NULL, id VARCHAR(36) NOT NULL, document_id VARCHAR(36) NOT NULL, metadata TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (owner, id), FOREIGN KEY (owner, document_id) REFERENCES equilens_documents(owner, id))",
  "CREATE INDEX IF NOT EXISTS equilens_revision_document ON equilens_revisions(owner, document_id)",
]
const sessionSchema = [
  "CREATE TABLE IF NOT EXISTS equilens_document_sessions (owner VARCHAR(64) PRIMARY KEY, context_id VARCHAR(36) NOT NULL, registered_at TEXT NOT NULL, first_created_at TEXT, retention_days INTEGER, expires_at TEXT, policy_version VARCHAR(64), export_until TEXT, legacy_pending INTEGER NOT NULL, revision INTEGER NOT NULL, revoked_at TEXT, registration TEXT)",
  "CREATE TABLE IF NOT EXISTS equilens_retention_deletions (id VARCHAR(36) PRIMARY KEY, owner VARCHAR(64) NOT NULL, expires_at TEXT NOT NULL, requested_at TEXT NOT NULL, reason VARCHAR(32) NOT NULL, completed_at TEXT)",
  "CREATE INDEX IF NOT EXISTS equilens_session_expiry ON equilens_document_sessions(expires_at)",
]

export async function connectDatabase(config = databaseConfig(), options: { readOnly?: boolean } = {}): Promise<Database> {
  const readOnly = options.readOnly === true
  const assertRead = (sql: string) => {
    if (readOnly && !/^\s*SELECT\b/i.test(sql)) throw new Error("Read-only database query required")
  }
  let database: Database
  if (config.provider === "sqlite") {
    if (!readOnly) mkdirSync(dirname(config.path), { recursive: true })
    const { DatabaseSync } = await import("node:sqlite")
    const sqlite = new DatabaseSync(config.path, { readOnly })
    sqlite.exec(readOnly ? "PRAGMA busy_timeout=5000;" : "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
    const connection: Connection = { async query(sql, values = []) {
      assertRead(sql)
      const statement = sqlite.prepare(sql.replace(/\$\d+/g, "?"))
      if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...values as SQLInputValue[]), changes: 0 }
      return { rows: [], changes: Number(statement.run(...values as SQLInputValue[]).changes) }
    } }
    let tail = Promise.resolve()
    database = {
      transaction<T>(work: (connection: Connection) => Promise<T>) {
        const result = tail.then(async () => {
          sqlite.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
          try { const value = await work(connection); sqlite.exec("COMMIT"); return value }
          catch (failure) { sqlite.exec("ROLLBACK"); throw failure }
        })
        tail = result.then(() => {}, () => {})
        return result
      },
      async close() { await tail; sqlite.close() },
    }
  } else {
    type Client = { query(sql: string, values?: (string | number | null)[]): Promise<{ rows: Row[]; rowCount: number }>; release(): void }
    type Pool = { connect(): Promise<Client>; end(): Promise<void>; on(event: string, handler: () => void): void }
    const driver = createRequire(import.meta.url)("gaussdb-node") as { Pool: new (options: typeof config.connection) => Pool }
    const pool = new driver.Pool(config.connection)
    pool.on("error", () => { console.error("GaussDB idle connection failed") })
    database = {
      async transaction<T>(work: (connection: Connection) => Promise<T>) {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const value = await work({ async query(sql, values) {
            assertRead(sql)
            const result = await client.query(sql, values)
            return { rows: result.rows, changes: result.rowCount }
          } })
          await client.query("COMMIT")
          return value
        } catch (failure) { await client.query("ROLLBACK").catch(() => {}); throw failure }
        finally { client.release() }
      },
      async close() { await pool.end() },
    }
  }
  if (readOnly) return database // No schema creation, migrations or journal-mode changes during inspection.
  try {
    await database.transaction(async connection => {
      await connection.query(schema[0])
      const { rows } = await connection.query("SELECT version FROM equilens_schema")
      if (rows.length && (rows.length !== 1 || ![1, 2].includes(Number(rows[0].version)))) throw new Error("Unsupported database schema")
      for (const sql of schema.slice(1)) await connection.query(sql)
      for (const sql of sessionSchema) await connection.query(sql)
      if (!rows.length) await connection.query("INSERT INTO equilens_schema(version) VALUES (2)")
      else if (Number(rows[0].version) === 1) await connection.query("UPDATE equilens_schema SET version=2 WHERE version=1")
    })
    return database
  } catch (failure) { await database.close(); throw failure }
}
