import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, type FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

export type DeletionIntent = { id: string; owner: string; expiresAt: string; requestedAt: string; reason: "anonymous-expired" }
export interface DeletionJournal {
  appendIntent(intent: DeletionIntent): Promise<void>
  readIntents(): Promise<DeletionIntent[]>
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function validateDeletionIntent(value: unknown): asserts value is DeletionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deletion journal")
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "expiresAt,id,owner,reason,requestedAt" || typeof record.id !== "string" || !uuid.test(record.id) || typeof record.owner !== "string" || !/^[a-f0-9]{64}$/.test(record.owner) || !iso(record.expiresAt) || !iso(record.requestedAt) || record.reason !== "anonymous-expired") throw new Error("Invalid deletion journal")
}

// Only directory handles are injectable for filesystem-fault tests; production uses real fsync.
type DirectoryFilesystem = { openDirectory(path: string, flags: "r"): Promise<Pick<FileHandle, "sync" | "close">> }
export function createFileDeletionJournal(directory: string, filesystem: DirectoryFilesystem = { openDirectory: open }): DeletionJournal {
  // The private directory must be outside Next's public tree, including absolute paths.
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
      const directory = await filesystem.openDirectory(path, "r")
      try { await directory.sync() } finally { await directory.close() }
      const parent = dirname(path)
      if (parent === path) break
      path = parent
    }
  }
  async function readIntents() {
    await ensureDirectory()
    const intents: DeletionIntent[] = []
    for (const name of (await readdir(root)).sort()) {
      if (isAbsolute(name) || !name.endsWith(".json") || !uuid.test(name.slice(0, -5))) throw new Error("Invalid deletion journal filename")
      const path = join(root, name)
      if (!(await lstat(path)).isFile()) throw new Error("Invalid deletion journal file")
      const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      try {
        const value: unknown = JSON.parse(await file.readFile("utf8"))
        validateDeletionIntent(value)
        if (`${value.id}.json` !== name || intents.some(intent => intent.owner === value.owner && intent.expiresAt === value.expiresAt)) throw new Error("Conflicting deletion journal")
        await file.chmod(0o600)
        await file.sync()
        intents.push(value)
      } finally { await file.close() }
    }
    // Existing files may be an earlier write whose directory sync failed. Never skip this barrier.
    if (intents.length) await syncDirectory()
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
      await syncDirectory()
    },
  }
}
