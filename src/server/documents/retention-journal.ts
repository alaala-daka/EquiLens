import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, type FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

export type DeletionIntent = { id: string; owner: string; expiresAt: string; requestedAt: string; reason: "anonymous-expired" }
export interface DeletionJournal {
  appendIntent(intent: DeletionIntent): Promise<void>
  readIntents(): Promise<DeletionIntent[]>
}

/** Shared private-journal primitives (C7 reuses these; anonymous semantics unchanged). */
export const journalUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function isJournalUuid(value: unknown): value is string {
  return typeof value === "string" && journalUuid.test(value)
}

/** Only directory handles are injectable for filesystem-fault tests; production uses real fsync. */
export type JournalDirectoryFilesystem = { openDirectory(path: string, flags: "r"): Promise<Pick<FileHandle, "sync" | "close">> }
export type PrivateJournalDirectory = {
  root: string
  ensureDirectory(): Promise<void>
  /** File and per-level parent directory durability barrier (mkdir may create a chain). */
  syncDirectory(): Promise<void>
}

/**
 * Private journal directory guard shared by the anonymous retention journal and
 * the C7 project deletion journal: outside `public/`, mode 700, path validated
 * as a directory, and every containing directory entry synced to the fs root.
 */
export function createPrivateJournalDirectory(directory: string, filesystem: JournalDirectoryFilesystem = { openDirectory: open }): PrivateJournalDirectory {
  const root = resolve(directory)
  const publicRoot = resolve("public")
  const compare = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
  if (!directory || compare(root) === compare(publicRoot) || compare(root).startsWith(compare(publicRoot + sep))) throw new Error("Invalid deletion journal directory")
  async function ensureDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory()) throw new Error("Invalid deletion journal directory")
    await chmod(root, 0o700)
  }
  async function syncDirectory() {
    // mkdir can create an entire chain. Sync every containing entry, even on retries
    // where those paths already exist after an earlier failed durability barrier.
    let path = root
    for (;;) {
      // Windows cannot fsync directory handles (EPERM/EISDIR). File fsync + atomic
      // rename still apply; the unsupported platform barrier is recorded as a gap
      // and production/Linux keeps the real per-level fsync. Any other failure, or a
      // directory opening failure on any platform, still fails closed.
      let handle: Awaited<ReturnType<JournalDirectoryFilesystem["openDirectory"]>> | undefined
      try {
        handle = await filesystem.openDirectory(path, "r")
      } catch (failure) {
        if (!directorySyncUnsupported(failure)) throw failure
      }
      if (handle) {
        try {
          try { await handle.sync() } catch (failure) { if (!directorySyncUnsupported(failure)) throw failure }
        } finally { await handle.close() }
      }
      const parent = dirname(path)
      if (parent === path) break
      path = parent
    }
  }
  return { root, ensureDirectory, syncDirectory }
}

/** Windows cannot open/fsync directory handles; treat only that platform error as an unsupported barrier. */
function directorySyncUnsupported(failure: unknown): boolean {
  if (process.platform !== "win32") return false
  const code = (failure as NodeJS.ErrnoException | undefined)?.code
  return code === "EPERM" || code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" || code === "UNKNOWN"
}

/** Validate a journal file name (`<uuid>.json`) and return the embedded id. */
export function journalFilenameId(name: string): string {
  if (isAbsolute(name) || !name.endsWith(".json")) throw new Error("Invalid deletion journal filename")
  const id = name.slice(0, -5)
  if (!journalUuid.test(id)) throw new Error("Invalid deletion journal filename")
  return id
}

export function validateDeletionIntent(value: unknown): asserts value is DeletionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deletion journal")
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "expiresAt,id,owner,reason,requestedAt" || typeof record.id !== "string" || !journalUuid.test(record.id) || typeof record.owner !== "string" || !/^[a-f0-9]{64}$/.test(record.owner) || !isIsoInstant(record.expiresAt) || !isIsoInstant(record.requestedAt) || record.reason !== "anonymous-expired") throw new Error("Invalid deletion journal")
}

export function createFileDeletionJournal(directory: string, filesystem: JournalDirectoryFilesystem = { openDirectory: open }): DeletionJournal {
  const privateDirectory = createPrivateJournalDirectory(directory, filesystem)
  const { root } = privateDirectory
  async function readIntents() {
    await privateDirectory.ensureDirectory()
    const intents: DeletionIntent[] = []
    for (const name of (await readdir(root)).sort()) {
      const id = journalFilenameId(name)
      const path = join(root, name)
      if (!(await lstat(path)).isFile()) throw new Error("Invalid deletion journal file")
      const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      try {
        const value: unknown = JSON.parse(await file.readFile("utf8"))
        validateDeletionIntent(value)
        if (value.id !== id || intents.some(intent => intent.owner === value.owner && intent.expiresAt === value.expiresAt)) throw new Error("Conflicting deletion journal")
        await file.chmod(0o600)
        await file.sync()
        intents.push(value)
      } finally { await file.close() }
    }
    // Existing files may be an earlier write whose directory sync failed. Never skip this barrier.
    if (intents.length) await privateDirectory.syncDirectory()
    return intents
  }
  return {
    readIntents,
    async appendIntent(intent) {
      validateDeletionIntent(intent)
      const intents = await readIntents()
      const existing = intents.find(value => value.owner === intent.owner && value.expiresAt === intent.expiresAt)
      if (existing) {
        if (existing.id !== intent.id || existing.requestedAt !== intent.requestedAt || existing.reason !== intent.reason) throw new Error("Conflicting deletion journal")
        return
      }
      if (intents.some(value => value.id === intent.id)) throw new Error("Conflicting deletion journal")
      const file = await open(join(root, `${intent.id}.json`), "wx", 0o600)
      try { await file.writeFile(JSON.stringify(intent)); await file.sync() } finally { await file.close() }
      await privateDirectory.syncDirectory()
    },
  }
}
