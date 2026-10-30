import { lstat } from "node:fs/promises"
import { resolve } from "node:path"
import { connectDatabase } from "../src/server/database/connection"
import { databaseConfig } from "../src/server/database/config"
import { createProjectDeletionJournal } from "../src/server/projects/deletion-journal"
import {
  inspectProjectLifecycle,
  projectObjectStore,
  projectReclaimBatch,
  reclaimPendingProjects,
  reclaimProject,
  recoverInterruptedProjectReclamations,
  replayProjectDeletionIntents,
  validateProjectDeletionReplay,
} from "../src/server/projects/reclamation"
import { projectDeletionJournalDirectory } from "../src/server/projects/lifecycle"

/**
 * C7 private project-lifecycle maintenance entry (no HTTP write route).
 *
 * `inspect` is read-only and prints redacted metadata (states/attempts/times and
 * counts only — never project names, object keys or material content).
 * `reclaim` retries pending/failed object/row reclamation for one project or all
 * pending records; `--apply` performs the changes.
 * `replay` validates a durable deletion journal against an offline-restored
 * database and (with `--apply --offline-restored-database`) applies it: restored
 * deleted projects are revoked and cleaned, never re-activated. Apply requires
 * the documented stop-the-world restore procedure.
 */
const commands = {
  inspect: [] as string[],
  reclaim: ["--project", "--apply"],
  replay: ["--journal", "--apply", "--offline-restored-database"],
}

const booleanFlags = new Set(["--apply", "--offline-restored-database"])

class UsageError extends Error {}

async function main() {
  try { process.loadEnvFile(".env.local") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const [command, ...args] = process.argv.slice(2)
  if (command === "--help" && !args.length) {
    console.log("inspect | reclaim [--project ID] [--apply] | replay [--journal DIR] --apply --offline-restored-database")
    return
  }
  if (!command || !(command in commands)) throw new UsageError("Invalid command")
  const allowed = commands[command as keyof typeof commands]
  const options = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!allowed.includes(flag) || options.has(flag)) throw new UsageError("Invalid options")
    if (booleanFlags.has(flag)) options.set(flag, true)
    else {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new UsageError("Missing option value")
      options.set(flag, value)
    }
  }
  if (command === "replay" && options.get("--apply") === true && options.get("--offline-restored-database") !== true) {
    throw new UsageError("Offline restored database confirmation required")
  }
  if (!process.env.DATABASE_PROVIDER) throw new UsageError("Explicit database provider required")
  const config = databaseConfig()
  if (config.provider === "sqlite" && !process.env.SQLITE_PATH) throw new UsageError("Explicit SQLite path required")
  if (config.provider === "sqlite") {
    const path = resolve(config.path)
    if (!(await lstat(path)).isFile()) throw new UsageError("Existing database required")
  }
  const database = await connectDatabase(config, { readOnly: options.get("--apply") !== true })
  try {
    if (command === "inspect") {
      const inspection = await inspectProjectLifecycle(database)
      console.log(JSON.stringify({
        deletions: inspection.deletions.map(item => ({
          projectId: item.projectId,
          state: item.record.state,
          reason: item.record.reason,
          requestedAt: item.record.requestedAt,
          attempts: item.record.attempts,
          completedAt: item.record.completedAt,
          clearedAt: item.record.clearedAt,
          pendingObjects: item.pendingObjects,
          clearedObjects: item.clearedObjects,
        })),
        pendingReclaimProjects: inspection.pendingReclaimProjects,
        recordlessDeleted: inspection.recordlessDeleted,
      }))
      return
    }
    const apply = options.get("--apply") === true
    const directory = options.has("--journal") ? resolve(String(options.get("--journal"))) : projectDeletionJournalDirectory(process.env)
    const journal = createProjectDeletionJournal(directory)
    const store = projectObjectStore(process.env)
    const now = () => new Date()
    const batch = projectReclaimBatch(process.env)
    if (command === "reclaim") {
      const target = options.has("--project") ? String(options.get("--project")) : undefined
      if (!apply) {
        const inspection = await inspectProjectLifecycle(database)
        const candidates = inspection.deletions.filter(item => (target ? item.projectId === target : item.record.state !== "reclaimed"))
        console.log(JSON.stringify({ candidates: candidates.map(item => ({ projectId: item.projectId, state: item.record.state })), applied: false }))
        return
      }
      if (target) {
        const outcome = await reclaimProject(database, target, { journal, store, now, batch })
        console.log(JSON.stringify({ projectId: target, state: outcome.state, attempts: outcome.attempts, deletedObjects: outcome.deletedObjects, skippedTables: outcome.skippedTables }))
        if (outcome.state !== "reclaimed" && outcome.state !== "missing") process.exitCode = 1
      } else {
        const outcomes = await reclaimPendingProjects(database, { journal, store, now, batch }, batch)
        console.log(JSON.stringify({ reclaimed: outcomes.filter(item => item.state === "reclaimed").length, failed: outcomes.filter(item => item.state === "failed").length, outcomes: outcomes.map(item => ({ state: item.state, attempts: item.attempts })) }))
        if (outcomes.some(item => item.state === "failed")) process.exitCode = 1
      }
      return
    }
    // replay
    const intents = await journal.readIntents()
    await validateProjectDeletionReplay(database, intents)
    if (!apply) {
      // Validation-only: journal + restored database deletion records must agree.
      const inspection = await inspectProjectLifecycle(database)
      console.log(JSON.stringify({ projects: intents.length, applied: false, existingRecords: inspection.deletions.length }))
      return
    }
    await recoverInterruptedProjectReclamations(database)
    const outcome = await replayProjectDeletionIntents(database, journal, intents, { store, now, batch })
    console.log(JSON.stringify({ ...outcome, applied: true }))
    if (outcome.pending) process.exitCode = 1
  } finally { await database.close() }
}

main().catch((failure: unknown) => {
  if (failure instanceof UsageError) {
    console.error("Project lifecycle maintenance usage error; see --help and explicit database/offline-restore requirements.")
    process.exitCode = 2
    return
  }
  console.error("Project lifecycle maintenance failed; verify configuration, journal and offline restore requirements.")
  process.exitCode = 1
})
