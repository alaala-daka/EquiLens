import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { connectDatabase } from "../src/server/database/connection"
import { databaseConfig } from "../src/server/database/config"
import { DocumentSessionRepository } from "../src/server/documents/session-repository"
import { enrollRetention, inspectRetention, replayRetention, writeInventory, type MaintenanceTarget } from "../src/server/documents/retention-maintenance"

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === "--help" && !args.length) {
    console.log("inspect --output FILE | enroll --manifest FILE [--apply] | replay --journal DIR --manifest FILE [--apply --offline-restored-database]")
    return
  }
  const allowed: Record<string, string[]> = { inspect: ["--output"], enroll: ["--manifest", "--apply"], replay: ["--journal", "--manifest", "--apply", "--offline-restored-database"] }
  if (!allowed[command]) throw new Error("Invalid command")
  const options = new Map<string, string | boolean>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!allowed[command].includes(flag) || options.has(flag)) throw new Error("Invalid options")
    if (["--apply", "--offline-restored-database"].includes(flag)) options.set(flag, true)
    else {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error("Missing option value")
      options.set(flag, value)
    }
  }
  const required = command === "inspect" ? ["--output"] : command === "enroll" ? ["--manifest"] : ["--manifest", "--journal"]
  if (required.some(flag => !options.has(flag))) throw new Error("Missing required option")
  if (!process.env.DATABASE_PROVIDER || (process.env.DATABASE_PROVIDER === "sqlite" && !process.env.SQLITE_PATH)) throw new Error("Explicit database configuration required")
  const config = databaseConfig()
  const target: MaintenanceTarget = config.provider === "sqlite" ? { provider: "sqlite", path: resolve(config.path) } : { provider: "gaussdb", host: config.connection.host, port: config.connection.port, database: config.connection.database }
  // Never silently create a new empty database while inspecting/enrolling/restoring an existing database.
  if (target.provider === "sqlite" && !(await lstat(target.path)).isFile()) throw new Error("Existing database required")
  const manifest: unknown = options.has("--manifest") ? JSON.parse(await readFile(String(options.get("--manifest")), "utf8")) : undefined
  const database = await connectDatabase(config)
  try {
    const apply = options.get("--apply") === true
    if (command === "inspect") {
      const inventory = await inspectRetention(database)
      await writeInventory(String(options.get("--output")), inventory)
      console.log(JSON.stringify({ owners: inventory.length }))
    } else if (command === "enroll") {
      const sessions = new DocumentSessionRepository(database, { now: () => new Date(), readPolicy: () => null })
      console.log(JSON.stringify({ owners: await enrollRetention(sessions, manifest, apply), applied: apply }))
    } else {
      console.log(JSON.stringify({ owners: await replayRetention(database, String(options.get("--journal")), manifest, target, apply, options.get("--offline-restored-database") === true), applied: apply }))
    }
  } finally { await database.close() }
}

main().catch(() => { console.error("Anonymous retention maintenance failed; verify configuration, manifests and offline restore requirements."); process.exitCode = 1 })
