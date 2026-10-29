import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  createPrivateJournalDirectory,
  isIsoInstant,
  isJournalUuid,
  journalFilenameId,
  journalUuid,
  type JournalDirectoryFilesystem,
} from "../documents/retention-journal"
import { projectDeletionReasons, type ProjectDeletionReason } from "./lifecycle-schema"

/**
 * C7 private project-deletion journal (one deletion intent per file).
 *
 * Frozen contract (round-six plan §4.2):
 *   { version: 1, id, projectId, reason, requestedBy, requestedAt, retentionUntil }
 * File name `<intent id>.json`; directories 700 / files 600; writes use a
 * temporary file + file fsync + atomic rename + per-level directory fsync, so a
 * crash never leaves a partially written intent that replay could misread. The
 * journal only contains metadata — never project names, material text or
 * credentials.
 *
 * A journal that cannot be written means the deletion must not delete any
 * object: the project stays access-revoked (`requested`) and the runtime retries.
 */
export type ProjectDeletionIntent = {
  version: 1
  id: string
  projectId: string
  reason: ProjectDeletionReason
  requestedBy: string
  requestedAt: string
  retentionUntil: string
}

export type ProjectDeletionJournal = {
  /** Absolute journal directory (already validated as a private path). */
  readonly directory: string
  appendIntent(intent: ProjectDeletionIntent): Promise<void>
  readIntents(): Promise<ProjectDeletionIntent[]>
}

const sortedKeys = "id,projectId,reason,requestedAt,requestedBy,retentionUntil,version"
const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const temporaryName = /^[a-f0-9-]{36}\.json\.tmp-[a-f0-9-]{8,64}$/

export function isProjectDeletionReason(value: unknown): value is ProjectDeletionReason {
  return typeof value === "string" && (projectDeletionReasons as readonly string[]).includes(value)
}

/** Strict exact-field validation; any extra/missing field or bad value rejects the whole batch. */
export function validateProjectDeletionIntent(value: unknown): asserts value is ProjectDeletionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project deletion journal")
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== sortedKeys || record.version !== 1) throw new Error("Invalid project deletion journal")
  if (typeof record.id !== "string" || !journalUuid.test(record.id) || typeof record.projectId !== "string" || !journalUuid.test(record.projectId)) throw new Error("Invalid project deletion journal")
  if (!isProjectDeletionReason(record.reason)) throw new Error("Invalid project deletion journal")
  if (typeof record.requestedBy !== "string" || !record.requestedBy.trim() || record.requestedBy.length > 36) throw new Error("Invalid project deletion journal")
  if (!isIsoInstant(record.requestedAt)) throw new Error("Invalid project deletion journal")
  if (typeof record.retentionUntil !== "string" || !dayPattern.test(record.retentionUntil) || !Number.isFinite(Date.parse(`${record.retentionUntil}T00:00:00Z`))) throw new Error("Invalid project deletion journal")
}

/** Whole-batch validation before any state change; conflicts reject restore. */
export function validateProjectDeletionIntents(intents: ProjectDeletionIntent[]): void {
  const ids = new Set<string>()
  const projects = new Map<string, string>()
  for (const intent of intents) {
    validateProjectDeletionIntent(intent)
    if (ids.has(intent.id)) throw new Error("Conflicting project deletion journal")
    ids.add(intent.id)
    const prior = projects.get(intent.projectId)
    const scope = `${intent.requestedAt}|${intent.reason}|${intent.retentionUntil}|${intent.requestedBy}`
    // The journal keeps exactly one intent per project; any second intent (even
    // with identical scope) is a conflicting duplicate, not a replay no-op.
    if (prior !== undefined && prior !== scope) throw new Error("Conflicting project deletion journal")
    if (prior !== undefined) throw new Error("Conflicting project deletion journal")
    projects.set(intent.projectId, scope)
  }
}

export function projectDeletionIntentMatches(left: ProjectDeletionIntent, right: ProjectDeletionIntent): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.reason === right.reason &&
    left.requestedBy === right.requestedBy && left.requestedAt === right.requestedAt && left.retentionUntil === right.retentionUntil
}

export function createProjectDeletionJournal(
  directory: string,
  filesystem: JournalDirectoryFilesystem = { openDirectory: open },
): ProjectDeletionJournal {
  const privateDirectory = createPrivateJournalDirectory(directory, filesystem)
  const { root } = privateDirectory
  async function readIntents(): Promise<ProjectDeletionIntent[]> {
    await privateDirectory.ensureDirectory()
    const intents: ProjectDeletionIntent[] = []
    for (const name of (await readdir(root)).sort()) {
      // A crash during a write may leave a temporary file; it is not a valid intent.
      if (temporaryName.test(name)) continue
      const id = journalFilenameId(name)
      const path = join(root, name)
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      try {
        const value: unknown = JSON.parse(await handle.readFile("utf8"))
        validateProjectDeletionIntent(value)
        if (value.id !== id) throw new Error("Conflicting project deletion journal")
        await handle.chmod(0o600)
        await handle.sync()
        intents.push(value)
      } finally { await handle.close() }
    }
    validateProjectDeletionIntents(intents)
    // Existing files may be an earlier write whose directory sync failed. Never skip this barrier.
    if (intents.length) await privateDirectory.syncDirectory()
    return intents
  }
  return {
    get directory() { return root },
    readIntents,
    async appendIntent(intent) {
      validateProjectDeletionIntent(intent)
      await privateDirectory.ensureDirectory()
      const intents = await readIntents()
      const existing = intents.find(value => value.projectId === intent.projectId)
      if (existing) {
        if (!projectDeletionIntentMatches(existing, intent)) throw new Error("Conflicting project deletion journal")
        return
      }
      if (intents.some(value => value.id === intent.id)) throw new Error("Conflicting project deletion journal")
      const target = join(root, `${intent.id}.json`)
      const temporary = join(root, `${intent.id}.json.tmp-${randomUUID().replace(/-/g, "")}`)
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify(intent))
        await handle.sync()
      } catch (failure) {
        await handle.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw failure
      } finally {
        await handle.close().catch(() => {})
      }
      try {
        await rename(temporary, target)
      } catch (failure) {
        await unlink(temporary).catch(() => {})
        throw failure
      }
      await privateDirectory.syncDirectory()
    },
  }
}

/** Offline-restore manifest target, mirroring the anonymous journal replay contract. */
export type ProjectLifecycleTarget = { provider: "sqlite"; path: string } | { provider: "gaussdb"; host: string; port: number; database: string }

/** Read + validate one journal directory without changing anything (used by replay pre-validation). */
export async function readProjectDeletionJournal(directory: string): Promise<{ journal: ProjectDeletionJournal; intents: ProjectDeletionIntent[] }> {
  const journal = createProjectDeletionJournal(directory)
  const intents = await journal.readIntents()
  return { journal, intents }
}

/** Keep `isJournalUuid`/`journalUuid` re-exported for the CLI's file shape checks. */
export { isJournalUuid, journalUuid }
