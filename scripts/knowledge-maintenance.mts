import { isAbsolute } from "node:path"
import { readFile } from "node:fs/promises"
import { connectDatabase } from "../src/server/database/connection"
import { applyKnowledgeMigrations } from "../src/server/knowledge/migrations"
import { runMaintenanceCli } from "../src/server/knowledge/cli"
import { createMaintenanceService } from "../src/server/knowledge/service"

/**
 * C6 private publication maintenance entry (no HTTP write route).
 *
 * Deliberately not part of the Next.js application: only a local operator with
 * database access can submit/publish/disable published knowledge/rule versions.
 * Publication additionally requires an existing enabled superadmin account, a
 * reviewer from EQUILENS_DOMAIN_REVIEWERS, reviewer != operator, the exact
 * expected digest, the verification time and review evidence.
 *
 * Explicit initialization only: this script loads .env.local, validates the
 * database provider, connects and applies the business migrations before any
 * command runs. Importing it never opens a database.
 */
let db: Awaited<ReturnType<typeof connectDatabase>> | undefined
try {
  try { process.loadEnvFile(".env.local") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (!["sqlite", "gaussdb"].includes(process.env.DATABASE_PROVIDER ?? "")) throw new Error("Explicit database provider required")
  if (process.env.DATABASE_PROVIDER === "sqlite" && (!process.env.SQLITE_PATH || !isAbsolute(process.env.SQLITE_PATH))) {
    throw new Error("Absolute SQLite path required")
  }
  db = await connectDatabase()
  await applyKnowledgeMigrations(db)
  const service = createMaintenanceService(db, process.env)
  const exitCode = await runMaintenanceCli(process.argv.slice(2), {
    service,
    env: process.env,
    readFile: path => readFile(path, "utf8"),
    output: line => console.log(line),
  })
  if (exitCode !== 0) process.exitCode = exitCode
} catch {
  console.error("发布维护失败：检查数据库配置、迁移与操作参数。")
  process.exitCode = 1
} finally {
  await db?.close()
}
