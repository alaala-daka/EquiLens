import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import type { Database } from "../database/connection"
import { databaseConfig } from "../database/config"
import type { DocumentSessionRepository } from "./session-repository"
import { createFileDeletionJournal, validateDeletionIntent, type DeletionIntent, type DeletionJournal } from "./retention-journal"

export { createFileDeletionJournal, type DeletionIntent, type DeletionJournal } from "./retention-journal"

async function deleteOwner(database: Database, intent: DeletionIntent) {
  validateDeletionIntent(intent)
  await database.transaction(async connection => {
    const { rows } = await connection.query("SELECT id,owner,expires_at FROM equilens_retention_deletions WHERE id=$1", [intent.id])
    if (rows.length && (rows[0].owner !== intent.owner || rows[0].expires_at !== intent.expiresAt)) throw new Error("Conflicting deletion record")
    if (!rows.length) await connection.query("INSERT INTO equilens_retention_deletions(id,owner,expires_at,requested_at,reason,completed_at) VALUES ($1,$2,$3,$4,$5,NULL)", [intent.id, intent.owner, intent.expiresAt, intent.requestedAt, intent.reason])
    const session = await connection.query("SELECT owner FROM equilens_document_sessions WHERE owner=$1", [intent.owner])
    if (session.rows.length) {
      await connection.query("UPDATE equilens_document_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE owner=$2", [intent.requestedAt, intent.owner])
    } else {
      // A backup may predate first session registration. Preserve a deny tombstone even in that case.
      await connection.query("INSERT INTO equilens_document_sessions(owner,context_id,registered_at,first_created_at,retention_days,expires_at,policy_version,export_until,legacy_pending,revision,revoked_at,registration) VALUES ($1,$2,$3,NULL,NULL,$4,NULL,NULL,0,0,$5,NULL)", [intent.owner, randomUUID(), intent.requestedAt, intent.expiresAt, intent.requestedAt])
    }
    await connection.query("DELETE FROM equilens_revisions WHERE owner=$1", [intent.owner])
    await connection.query("DELETE FROM equilens_documents WHERE owner=$1", [intent.owner])
    // Inputs/prompts are inside the deleted document/revision metadata. No separate derived store exists.
    await connection.query("UPDATE equilens_retention_deletions SET completed_at=COALESCE(completed_at,$1) WHERE id=$2", [new Date().toISOString(), intent.id])
  })
}

export async function replayDeletionIntents(database: Database, journal: DeletionJournal): Promise<void> {
  const intents = await journal.readIntents()
  // Validate the entire set before making any state changes, including injected/remote journals.
  await validateReplayTarget(database, intents)
  for (const intent of intents) await deleteOwner(database, intent)
}

export async function validateReplayTarget(database: Database, intents: DeletionIntent[]): Promise<void> {
  const ids = new Set<string>(), scopes = new Set<string>()
  for (const intent of intents) {
    validateDeletionIntent(intent)
    const scope = `${intent.owner}:${intent.expiresAt}`
    if (ids.has(intent.id) || scopes.has(scope)) throw new Error("Conflicting deletion journal")
    ids.add(intent.id); scopes.add(scope)
  }
  await database.transaction(async c => {
    for (const intent of intents) {
      const { rows } = await c.query("SELECT id,owner,expires_at,requested_at,reason FROM equilens_retention_deletions WHERE id=$1 OR (owner=$2 AND expires_at=$3)", [intent.id, intent.owner, intent.expiresAt])
      if (rows.some(row => row.id !== intent.id || row.owner !== intent.owner || row.expires_at !== intent.expiresAt || row.requested_at !== intent.requestedAt || row.reason !== intent.reason)) throw new Error("Conflicting deletion record")
    }
  })
}

export async function cleanExpiredSessions(database: Database, sessions: DocumentSessionRepository, journal: DeletionJournal, now: () => Date): Promise<{ deleted: number; failed: number }> {
  const result = { deleted: 0, failed: 0 }
  const candidates = await sessions.expiredOwners(100)
  let intents: DeletionIntent[]
  try {
    intents = await journal.readIntents()
    for (const intent of intents) validateDeletionIntent(intent)
  } catch { return { deleted: 0, failed: Math.max(1, candidates.length) } }
  for (const session of candidates) {
    const current = now()
    if (!session.expiresAt || (!session.revokedAt && (Date.parse(session.expiresAt) > current.getTime() || (session.exportUntil && Date.parse(session.exportUntil) > current.getTime())))) continue
    try {
      const intent = intents.find(value => value.owner === session.owner && value.expiresAt === session.expiresAt) ?? { id: randomUUID(), owner: session.owner, expiresAt: session.expiresAt, requestedAt: current.toISOString(), reason: "anonymous-expired" as const }
      await journal.appendIntent(intent)
      if (!intents.some(value => value.id === intent.id)) intents.push(intent)
      await deleteOwner(database, intent)
      result.deleted++
    } catch { result.failed++ }
  }
  return result
}

export function emptySessionRetentionDays(env: Record<string, string | undefined> = process.env): number | null {
  const value = env.ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS
  if (value === undefined) return null
  const days = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(days) || !Number.isFinite(new Date(Date.now() - days * 86400000).getTime())) throw new Error("Invalid empty session cleanup configuration")
  return days
}

export async function cleanEmptySessions(database: Database, now: () => Date, days: number | null): Promise<number> {
  if (days === null) return 0
  if (!Number.isSafeInteger(days) || days < 1) throw new Error("Invalid empty session cleanup configuration")
  const cutoff = new Date(now().getTime() - days * 86400000).toISOString()
  return database.transaction(async connection => {
    const { rows } = await connection.query("SELECT owner FROM equilens_document_sessions s WHERE registered_at<=$1 AND first_created_at IS NULL AND expires_at IS NULL AND revoked_at IS NULL AND legacy_pending=0 AND NOT EXISTS (SELECT 1 FROM equilens_documents d WHERE d.owner=s.owner) AND NOT EXISTS (SELECT 1 FROM equilens_revisions r WHERE r.owner=s.owner) AND NOT EXISTS (SELECT 1 FROM equilens_retention_deletions x WHERE x.owner=s.owner) ORDER BY registered_at,owner LIMIT 100", [cutoff])
    for (const row of rows) await connection.query("DELETE FROM equilens_document_sessions WHERE owner=$1", [String(row.owner)])
    return rows.length
  })
}

export function createRetentionRuntime(options: { initialize: () => Promise<void>; sweep: () => Promise<void>; schedule: (tick: () => void, intervalMs: number) => (() => void) }) {
  let started = false
  let cancel: (() => void) | undefined
  let boot: Promise<void> | undefined
  let sweep: Promise<void> | undefined
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  let readiness: Promise<void>
  function resetReady() {
    readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    // Instrumentation deliberately does not await ready. Always observe the rejection internally.
    void readiness.catch(() => {})
  }
  resetReady()
  function tick() {
    if (!started || sweep) return
    sweep = Promise.resolve().then(options.sweep).catch(() => { console.error("Anonymous retention sweep failed") }).finally(() => { sweep = undefined })
  }
  return {
    start() {
      if (started || boot) return
      started = true
      resetReady()
      boot = Promise.resolve().then(options.initialize).then(() => {
        if (started) { cancel = options.schedule(tick, 3600000); tick() }
        boot = undefined
        resolveReady()
      }).catch(() => {
        boot = undefined
        started = false
        rejectReady(new Error("Document data is temporarily unavailable"))
        console.error("Anonymous retention initialization failed")
      })
    },
    async stop() {
      started = false
      cancel?.(); cancel = undefined
      await boot
      await sweep
    },
    ready() { return readiness },
  }
}

type Runtime = ReturnType<typeof createRetentionRuntime>
const state = globalThis as typeof globalThis & { equilensRetentionRuntime?: Runtime }
function runtime() {
  return state.equilensRetentionRuntime ??= createRetentionRuntime({
    initialize: async () => {
      const { initializeDocumentServices } = await import("./service")
      const { database } = await initializeDocumentServices()
      const journal = configuredJournal()
      emptySessionRetentionDays()
      await replayDeletionIntents(database, journal)
    },
    sweep: async () => {
      const { initializeDocumentServices } = await import("./service")
      const { database, sessions } = await initializeDocumentServices()
      const result = await cleanExpiredSessions(database, sessions, configuredJournal(), () => new Date())
      if (result.failed) console.error("Anonymous retention cleanup incomplete")
      await cleanEmptySessions(database, () => new Date(), emptySessionRetentionDays())
    },
    schedule: (tick, intervalMs) => { const timer = setInterval(tick, intervalMs); timer.unref(); return () => clearInterval(timer) },
  })
}
function configuredJournal() {
  const config = databaseConfig()
  const directory = process.env.ANONYMOUS_DELETION_JOURNAL_DIR ?? (config.provider === "sqlite" ? join(dirname(config.path), "retention-journal") : null)
  if (!directory) throw new Error("Private deletion journal directory is required")
  return createFileDeletionJournal(directory)
}
export function startRetentionRuntime(): void { runtime().start() }
export async function stopRetentionRuntime(): Promise<void> { await state.equilensRetentionRuntime?.stop() }
export function retentionRuntimeReady(): Promise<void> { return runtime().ready() }
