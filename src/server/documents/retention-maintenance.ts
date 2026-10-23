import { createHash } from "node:crypto"
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import type { Database } from "../database/connection"
import { DocumentSessionRepository, type LegacyRetentionRegistration } from "./session-repository"
import { createFileDeletionJournal, validateDeletionIntent, type DeletionIntent, type DeletionJournal } from "./retention-journal"
import { replayDeletionIntents, validateReplayTarget } from "./retention-cleanup"

export type MaintenanceTarget = { provider: "sqlite"; path: string } | { provider: "gaussdb"; host: string; port: number; database: string }
export type RetentionInventory = { owner: string; firstCreatedAt: string | null; documentCount: number; revisionCount: number; registrationState: string }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const fields = (value: Record<string, unknown>, names: string) => Object.keys(value).sort().join(",") === names
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid maintenance manifest")
  return value as Record<string, unknown>
}

export function inspectRetention(database: Database): Promise<RetentionInventory[]> {
  return database.transaction(async c => {
    const docs = (await c.query("SELECT owner,metadata FROM equilens_documents")).rows
    const revisions = (await c.query("SELECT owner FROM equilens_revisions")).rows
    const sessions = (await c.query("SELECT owner,registration,legacy_pending,revoked_at FROM equilens_document_sessions")).rows
    const owners = new Set([...docs, ...revisions, ...sessions].map(row => String(row.owner)))
    return [...owners].sort().map(owner => {
      if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("Invalid stored owner")
      const owned = docs.filter(row => row.owner === owner)
      const dates = owned.map(row => Date.parse(JSON.parse(String(row.metadata)).createdAt))
      if (dates.some(date => !Number.isFinite(date))) throw new Error("Invalid stored creation time")
      const session = sessions.find(row => row.owner === owner)
      return { owner, firstCreatedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, documentCount: owned.length, revisionCount: revisions.filter(row => row.owner === owner).length,
        registrationState: session?.revoked_at ? "revoked" : session?.registration ? "legacy_registered" : session && !Number(session.legacy_pending) ? "registered" : owned.length ? "legacy_pending" : "empty" }
    })
  })
}

export async function writeInventory(path: string, inventory: RetentionInventory[]): Promise<void> {
  const output = resolve(path), parent = await realpath(dirname(output)), publicRoot = resolve("public")
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  for (const candidate of [output, join(parent, output.slice(dirname(output).length + 1))]) {
    if (normalize(candidate) === normalize(publicRoot) || normalize(candidate).startsWith(normalize(publicRoot + sep))) throw new Error("Private output required")
  }
  const file = await open(output, "wx", 0o600)
  try { await file.writeFile(JSON.stringify(inventory, null, 2)); await file.sync() } finally { await file.close() }
}

export async function enrollRetention(sessions: DocumentSessionRepository, manifest: unknown, apply = false): Promise<number> {
  if (!Array.isArray(manifest)) throw new Error("Invalid enrollment manifest")
  for (const value of manifest) {
    const input = record(value)
    if (!fields(input, "exportUntil,notifiedAt,operator,owner,purpose,retentionDays") || typeof input.owner !== "string" || !/^[a-f0-9]{64}$/.test(input.owner) || typeof input.retentionDays !== "number" || ["exportUntil", "notifiedAt", "operator", "purpose"].some(key => typeof input[key] !== "string" || !input[key])) throw new Error("Invalid enrollment manifest")
  }
  return sessions.registerLegacyBatch(manifest as LegacyRetentionRegistration[], apply)
}

export async function replayRetention(database: Database, directory: string, input: unknown, target: MaintenanceTarget, apply = false, offline = false, journal?: DeletionJournal): Promise<number> {
  const manifest = record(input)
  if (!fields(manifest, "files,target,version") || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid replay manifest")
  const actual = record(manifest.target)
  if (!fields(actual, Object.keys(target).sort().join(",")) || Object.entries(target).some(([key, value]) => actual[key] !== value)) throw new Error("Replay target mismatch")
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid journal directory")
  const names = (await readdir(directory)).sort()
  const files = manifest.files.map(value => {
    const file = record(value)
    if (!fields(file, "name,sha256") || typeof file.name !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(file.name) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid journal manifest")
    return { name: file.name, sha256: file.sha256 }
  }).sort((a, b) => a.name.localeCompare(b.name))
  if (JSON.stringify(names) !== JSON.stringify(files.map(file => file.name))) throw new Error("Incomplete journal manifest")
  const intents: DeletionIntent[] = []
  for (const file of files) {
    const path = join(directory, file.name)
    if (!(await lstat(path)).isFile()) throw new Error("Invalid journal file")
    const bytes = await readFile(path)
    if (hash(bytes) !== file.sha256) throw new Error("Journal digest mismatch")
    const intent: unknown = JSON.parse(bytes.toString("utf8"))
    validateDeletionIntent(intent)
    if (`${intent.id}.json` !== file.name) throw new Error("Journal filename mismatch")
    intents.push(intent)
  }
  await validateReplayTarget(database, intents)
  if (apply) {
    if (!offline) throw new Error("Offline restored database confirmation required")
    const durable = journal ?? createFileDeletionJournal(directory)
    const verified = await durable.readIntents()
    const canonical = (items: DeletionIntent[]) => JSON.stringify(items.map(value => [value.id, value.owner, value.expiresAt, value.requestedAt, value.reason]).sort((a, b) => a[0].localeCompare(b[0])))
    if (canonical(verified) !== canonical(intents)) throw new Error("Journal changed during validation")
    await replayDeletionIntents(database, { readIntents: async () => verified, appendIntent: value => durable.appendIntent(value) })
  }
  return new Set(intents.map(intent => intent.owner)).size
}
