import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Database, Row } from "../database/connection"
import { createFileObjectStore } from "../storage/file-store"
import { assertObjectKey, createUnavailableObjectStore, ObjectStoreError, type PrivateObjectStore } from "../storage/obs"
import {
  PROJECT_RUNTIME_TABLES,
  PROJECT_SCOPED_TABLES,
  projectDeletionRecord,
  type ProjectDeletionReason,
  type ProjectDeletionRecord,
} from "./lifecycle-schema"
import type { ProjectDeletionIntent, ProjectDeletionJournal } from "./deletion-journal"
import { validateProjectDeletionIntent, validateProjectDeletionIntents } from "./deletion-journal"
import { ProjectRepository } from "./repository"
import type { ProjectRecord } from "./types"

/**
 * C7 object reclamation and ordered project-row deletion.
 *
 * Deletion order (frozen): access revocation + `requested` record (repository
 * transaction, before this module) → journal fsync → object inventory from the
 * project rows → per-object delete/attempts → ordered row deletion → completed.
 *
 * The private object store has no list API, so the inventory is rebuilt from the
 * project-scoped rows that reference objects. A write that races the inventory
 * can still leave an orphan object after revocation; uploads are authorization-
 * gated per request and the residual race is documented (not claimed as zero).
 * Every key is asserted to belong to this project before deletion, so one
 * project's cleanup can never delete another project's or an anonymous object.
 */
export type ReclaimDependencies = {
  journal: ProjectDeletionJournal
  store: PrivateObjectStore
  now?: () => Date
  batch?: number
  maxBatches?: number
}

export type ReclaimOutcome = {
  state: "reclaimed" | "failed" | "pending" | "missing"
  attempts: number
  deletedObjects: number
  skippedTables: string[]
  error?: string
}

export type DeletionInspection = {
  projectId: string
  record: ProjectDeletionRecord
  pendingObjects: number
  clearedObjects: number
}

const safeError = (code: string) => code.slice(0, 64)

export function projectReclaimBatch(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PROJECT_RECLAIM_BATCH
  if (raw === undefined) return 10
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("Invalid project reclaim batch configuration")
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 100) throw new Error("Invalid project reclaim batch configuration")
  return value
}

/**
 * C7 object store selection for the lifecycle runtime/Maintenance CLI.
 * Production (or unknown env) fails closed exactly like the server runtime; only
 * an explicit development opt-in uses the local file adapter.
 */
export function projectObjectStore(env: Record<string, string | undefined> = process.env): PrivateObjectStore {
  if (env.NODE_ENV !== "development" || env.EQUILENS_SYNTHETIC_STORAGE !== "1") return createUnavailableObjectStore()
  return createFileObjectStore(resolve(env.EQUILENS_DEV_OBJECT_STORE ?? "data/dev-objects"))
}

function tableMissing(failure: unknown): boolean {
  const value = failure as { code?: string; message?: string }
  if (value.code === "42P01" || /^42P01$/.test(String(value.code))) return true
  return /no such table/i.test(String(value.message))
}

/** Provider-safe existence probe: a missing table fails in its own transaction. */
async function existingProjectTables(database: Database): Promise<{ existing: string[]; skipped: string[] }> {
  const existing: string[] = []
  const skipped: string[] = []
  for (const table of PROJECT_SCOPED_TABLES) {
    try {
      await database.transaction(connection => connection.query(`SELECT 1 FROM ${table} WHERE 1=0`))
      existing.push(table)
    } catch (failure) {
      if (!tableMissing(failure)) throw failure
      skipped.push(table)
    }
  }
  return { existing, skipped }
}

const pageSize = 100
const maxInventoryObjects = 100_000

/** Rebuild every project-private object key from the project-scoped rows. */
export async function projectObjectKeys(database: Database, projectId: string): Promise<string[]> {
  const keys = new Set<string>()
  const prefix = `projects/${projectId}/`
  const add = (key: unknown) => {
    if (typeof key !== "string" || !key) return
    // Never delete an object that is not under this project's namespace.
    assertObjectKey(key)
    if (!key.startsWith(prefix)) throw new Error("Project object key mismatch")
    keys.add(key)
  }
  const collect = async (sql: string, mapper: (row: Row) => unknown = row => row.object_key) => {
    for (let offset = 0; ; offset += pageSize) {
      const { rows } = await database.transaction(connection => connection.query(`${sql} LIMIT $2 OFFSET $3`, [projectId, pageSize, offset]))
      for (const row of rows) add(mapper(row))
      if (rows.length < pageSize) return
      if (keys.size > maxInventoryObjects) throw new Error("Project object inventory too large")
    }
  }
  const table = async (sql: string) => { try { await collect(sql) } catch (failure) { if (!tableMissing(failure)) throw failure } }
  await table("SELECT object_key FROM equilens_material_versions WHERE project_id=$1 ORDER BY object_key")
  await table("SELECT object_key FROM equilens_material_upload_intents WHERE project_id=$1 ORDER BY object_key")
  await table("SELECT object_key FROM equilens_material_residue WHERE project_id=$1 ORDER BY object_key")
  await table("SELECT object_key FROM equilens_project_document_writes WHERE project_id=$1 ORDER BY object_key")
  await table("SELECT object_key FROM equilens_result_exports WHERE project_id=$1 ORDER BY object_key")
  await collect(
    "SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1 ORDER BY id",
    row => {
      const value: unknown = JSON.parse(String(row.metadata))
      if (!value || typeof value !== "object" || typeof (value as { objectKey?: unknown }).objectKey !== "string") throw new Error("Invalid stored project document version")
      return (value as { objectKey: string }).objectKey
    },
  )
  return [...keys].sort()
}

async function reclamationCounts(database: Database, projectId: string): Promise<{ pending: number; cleared: number }> {
  return database.transaction(async connection => {
    const pending = (await connection.query("SELECT COUNT(*) AS count FROM equilens_project_reclamations WHERE project_id=$1 AND state='pending'", [projectId])).rows[0]
    const cleared = (await connection.query("SELECT COUNT(*) AS count FROM equilens_project_reclamations WHERE project_id=$1 AND state='cleared'", [projectId])).rows[0]
    return { pending: Number(pending?.count ?? 0), cleared: Number(cleared?.count ?? 0) }
  })
}

async function ensureReclamations(database: Database, projectId: string, keys: string[], now: string): Promise<void> {
  if (!keys.length) return
  await database.transaction(async connection => {
    for (const key of keys) {
      const existing = (await connection.query("SELECT id FROM equilens_project_reclamations WHERE object_key=$1", [key])).rows[0]
      if (existing) continue
      await connection.query(
        "INSERT INTO equilens_project_reclamations(id,project_id,object_key,state,attempts,last_error,created_at,updated_at,cleared_at) VALUES($1,$2,$3,'pending',0,NULL,$4,$5,NULL)",
        [randomUUID(), projectId, key, now, now],
      )
    }
  })
}

async function pendingReclamations(database: Database, projectId: string, limit: number): Promise<Array<{ id: string; objectKey: string }>> {
  return database.transaction(async connection => {
    const { rows } = await connection.query(
      "SELECT id,object_key FROM equilens_project_reclamations WHERE project_id=$1 AND state='pending' ORDER BY object_key LIMIT $2",
      [projectId, limit],
    )
    return rows.map(row => ({ id: String(row.id), objectKey: String(row.object_key) }))
  })
}

async function markReclamation(database: Database, id: string, cleared: boolean, now: string, error?: string): Promise<void> {
  if (cleared) {
    await database.transaction(connection => connection.query(
      "UPDATE equilens_project_reclamations SET state='cleared',attempts=attempts+1,last_error=NULL,updated_at=$1,cleared_at=$2 WHERE id=$3 AND state='pending'",
      [now, now, id],
    ))
  } else {
    await database.transaction(connection => connection.query(
      "UPDATE equilens_project_reclamations SET attempts=attempts+1,last_error=$1,updated_at=$2 WHERE id=$3 AND state='pending'",
      [safeError(error ?? "OBJECT_DELETE_FAILED"), now, id],
    ))
  }
}

/**
 * Conditional deletion-record transitions. Callers write numbered placeholders in
 * ascending textual order and each number appears once (the shared connection
 * rewrites `$n` to positional `?`, so a repeated/out-of-order number would bind
 * the wrong value — or silently affect zero rows).
 */
async function transitionDeletion(database: Database, sql: string, values: (string | number | null)[]): Promise<boolean> {
  return database.transaction(async connection => (await connection.query(sql, values)).changes === 1)
}

async function beginReclaim(database: Database, projectId: string): Promise<boolean> {
  return transitionDeletion(database, "UPDATE equilens_project_deletions SET state='reclaiming' WHERE project_id=$1 AND state IN ('requested','failed')", [projectId])
}

/**
 * Recover claims owned by the previous process, only before lifecycle readiness
 * or during explicitly offline restore. Never call from an online retry: a
 * concurrent reclaiming operation still owns its claim until it finishes.
 * Object checkpoints are retained so recovery only retries pending objects.
 */
export async function recoverInterruptedProjectReclamations(database: Database): Promise<number> {
  return database.transaction(async connection => (await connection.query(
    "UPDATE equilens_project_deletions SET state='failed',attempts=attempts+1,last_error='INTERRUPTED' WHERE state='reclaiming'",
  )).changes)
}

async function failReclaim(database: Database, projectId: string, error: string): Promise<boolean> {
  return transitionDeletion(database,
    "UPDATE equilens_project_deletions SET state='failed',attempts=attempts+1,last_error=$1 WHERE project_id=$2 AND state='reclaiming'",
    [safeError(error), projectId])
}

/** Reset a tombstone record only when replay proves the project row is visible again. */
async function resetTombstoneForReplay(database: Database, projectId: string): Promise<void> {
  await transitionDeletion(database,
    "UPDATE equilens_project_deletions SET state='requested',completed_at=NULL,cleared_at=NULL,last_error=NULL,attempts=0 WHERE project_id=$1 AND state='reclaimed'",
    [projectId])
  await transitionDeletion(database,
    "UPDATE equilens_project_deletions SET state='requested',completed_at=NULL,cleared_at=NULL,last_error=NULL WHERE project_id=$1 AND state='failed'",
    [projectId])
}

/**
 * Delete every project-scoped row in the frozen order. Tables that do not exist
 * (B-line runtime schemas before wiring) are skipped and reported; the project
 * row itself is never physically deleted (tombstone).
 */
export async function deleteProjectRows(database: Database, projectId: string): Promise<string[]> {
  const { existing, skipped } = await existingProjectTables(database)
  await database.transaction(async connection => {
    for (const table of existing) await connection.query(`DELETE FROM ${table} WHERE project_id=$1`, [projectId])
  })
  return skipped
}

function intentFromRecord(record: ProjectDeletionRecord, project: ProjectRecord | null): ProjectDeletionIntent {
  const retentionUntil = record.retentionUntil ?? project?.retentionUntil
  if (!retentionUntil) throw new Error("Deletion record has no retention date for the journal")
  const intent: ProjectDeletionIntent = {
    version: 1,
    id: record.intentId,
    projectId: record.projectId,
    reason: record.reason,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    retentionUntil,
  }
  validateProjectDeletionIntent(intent)
  return intent
}

/** Journal intent for an existing deletion record (used by HTTP delete and the retention sweep). */
export function journalIntentForRecord(record: ProjectDeletionRecord, project: ProjectRecord | null = null): ProjectDeletionIntent {
  return intentFromRecord(record, project)
}

async function readDeletionRecord(database: Database, projectId: string): Promise<ProjectDeletionRecord | null> {
  const { rows } = await database.transaction(connection => connection.query("SELECT * FROM equilens_project_deletions WHERE project_id=$1", [projectId]))
  return rows.length ? projectDeletionRecord(rows[0]) : null
}

/**
 * Reclaim one project: journal barrier first (no object is deleted when the
 * journal cannot be durably written), then object inventory/per-object deletes,
 * then ordered row deletes and the completed record. Any failure keeps the
 * project access-revoked with `failed` + retry state — never `active`.
 */
export async function reclaimProject(database: Database, projectId: string, dependencies: ReclaimDependencies): Promise<ReclaimOutcome> {
  const now = dependencies.now ?? (() => new Date())
  const batch = dependencies.batch ?? 10
  const maxBatches = dependencies.maxBatches ?? 100
  const repository = new ProjectRepository(database, now)
  const record = await readDeletionRecord(database, projectId)
  if (!record) return { state: "missing", attempts: 0, deletedObjects: 0, skippedTables: [] }
  if (record.state === "reclaimed") return { state: "reclaimed", attempts: record.attempts, deletedObjects: 0, skippedTables: [] }
  const project = await repository.findAny(projectId)
  if (!project) return { state: "missing", attempts: record.attempts, deletedObjects: 0, skippedTables: [] }

  // 1) Durable journal intent before any object deletion.
  try {
    await dependencies.journal.appendIntent(intentFromRecord(record, project))
  } catch {
    // This caller has not acquired a claim yet. A concurrent owner must keep
    // its state even when our independent journal check fails.
    return { state: "pending", attempts: record.attempts, deletedObjects: 0, skippedTables: [], error: "JOURNAL_UNAVAILABLE" }
  }

  // 2) Conditional state transition requested/failed → reclaiming.
  if (!await beginReclaim(database, projectId)) {
    const current = await readDeletionRecord(database, projectId)
    if (!current) return { state: "missing", attempts: 0, deletedObjects: 0, skippedTables: [] }
    if (current.state === "reclaimed") return { state: "reclaimed", attempts: current.attempts, deletedObjects: 0, skippedTables: [] }
    // Another worker is reclaiming or the record changed; stay retryable.
    return { state: "pending", attempts: current.attempts, deletedObjects: 0, skippedTables: [] }
  }

  let deletedObjects = 0
  let skippedTables: string[] = []
  try {
    const keys = await projectObjectKeys(database, projectId)
    const timestamp = now().toISOString()
    await ensureReclamations(database, projectId, keys, timestamp)
    let exhausted = false
    for (let round = 0; round < maxBatches; round++) {
      const pending = await pendingReclamations(database, projectId, batch)
      if (!pending.length) break
      for (const item of pending) {
        try {
          await dependencies.store.delete(item.objectKey)
          await markReclamation(database, item.id, true, now().toISOString())
          deletedObjects++
        } catch (failure) {
          const code = failure instanceof ObjectStoreError && failure.code === "UNAVAILABLE" ? "STORAGE_UNAVAILABLE" : "OBJECT_DELETE_FAILED"
          await markReclamation(database, item.id, false, now().toISOString(), code)
        }
      }
      if (round === maxBatches - 1 && (await reclamationCounts(database, projectId)).pending > 0) exhausted = true
    }
    const remaining = await reclamationCounts(database, projectId)
    if (remaining.pending > 0 || exhausted) {
      await failReclaim(database, projectId, "OBJECT_RECLAIM_INCOMPLETE")
      return { state: "failed", attempts: (await readDeletionRecord(database, projectId))?.attempts ?? record.attempts, deletedObjects, skippedTables, error: "OBJECT_RECLAIM_INCOMPLETE" }
    }

    // 3) Ordered row deletion + completion in one transaction (objects are gone).
    const plan = await existingProjectTables(database)
    skippedTables = plan.skipped
    await database.transaction(async connection => {
      for (const table of plan.existing) await connection.query(`DELETE FROM ${table} WHERE project_id=$1`, [projectId])
      const completed = await connection.query(
        "UPDATE equilens_project_deletions SET state='reclaimed',attempts=attempts+1,last_error=NULL,completed_at=$1,cleared_at=$2 WHERE project_id=$3 AND state='reclaiming'",
        [now().toISOString(), now().toISOString(), projectId],
      )
      if (completed.changes !== 1) throw new Error("Deletion record changed during row reclamation")
    })
    const saved = await readDeletionRecord(database, projectId)
    return { state: "reclaimed", attempts: saved?.attempts ?? record.attempts + 1, deletedObjects, skippedTables }
  } catch (failure) {
    await failReclaim(database, projectId, failure instanceof Error && /changed during row/.test(failure.message) ? "CONFLICT" : "ROW_DELETE_FAILED")
    const saved = await readDeletionRecord(database, projectId)
    return { state: "failed", attempts: saved?.attempts ?? record.attempts, deletedObjects, skippedTables, error: "ROW_DELETE_FAILED" }
  }
}

/** Retry pending/failed deletion records (bounded per sweep). */
export async function reclaimPendingProjects(database: Database, dependencies: ReclaimDependencies, limit = 10): Promise<ReclaimOutcome[]> {
  const pending = await database.transaction(async connection =>
    (await connection.query("SELECT project_id FROM equilens_project_deletions WHERE state IN ('requested','failed','reclaiming') ORDER BY requested_at, project_id LIMIT $1", [Math.max(1, Math.min(100, limit))])).rows.map(row => String(row.project_id)))
  const outcomes: ReclaimOutcome[] = []
  for (const projectId of pending) outcomes.push(await reclaimProject(database, projectId, dependencies))
  return outcomes
}

/** Redacted lifecycle inspection for the private CLI: metadata/counts only. */
export async function inspectProjectLifecycle(database: Database): Promise<{ deletions: DeletionInspection[]; pendingReclaimProjects: number; recordlessDeleted: number }> {
  const { rows } = await database.transaction(connection => connection.query("SELECT * FROM equilens_project_deletions ORDER BY requested_at, project_id"))
  const deletions: DeletionInspection[] = []
  for (const row of rows) {
    const record = projectDeletionRecord(row)
    const counts = await reclamationCounts(database, record.projectId)
    deletions.push({ projectId: record.projectId, record, pendingObjects: counts.pending, clearedObjects: counts.cleared })
  }
  const recordless = await new ProjectRepository(database).listRecordlessDeleted(100)
  return {
    deletions,
    pendingReclaimProjects: deletions.filter(item => item.record.state !== "reclaimed").length,
    recordlessDeleted: recordless.length,
  }
}

export type ReplayOutcome = {
  projects: number
  revoked: number
  tombstones: number
  reclaimed: number
  pending: number
  skippedTables: string[]
}

/** Same whole-batch preflight for read-only maintenance and actual replay. */
export async function validateProjectDeletionReplay(database: Database, intents: ProjectDeletionIntent[]): Promise<void> {
  validateProjectDeletionIntents(intents)
  for (const intent of intents) {
    const existing = await readDeletionRecord(database, intent.projectId)
    if (existing) {
      const conflict = existing.intentId !== intent.id || existing.reason !== intent.reason ||
        existing.requestedBy !== intent.requestedBy || existing.requestedAt !== intent.requestedAt ||
        (existing.retentionUntil !== null && existing.retentionUntil !== intent.retentionUntil)
      if (conflict) throw new Error("Conflicting project deletion record")
    }
  }
}

/**
 * Offline-restore / startup replay of the durable deletion journal.
 *
 * Whole-batch validation happens before any change. Per project (idempotent):
 * - restored DB still has the project row: set `status='deleted'` (access
 *   revoked) and validate/insert the deletion record; then reclaim the object
 *   inventory rebuilt from the restored rows. A project row is never created or
 *   reactivated.
 * - restored DB has no project row: write/keep only the deletion-record
 *   tombstone; nothing is reclaimed.
 * Conflicting journal/DB-record content rejects the whole replay before changes.
 */
export async function replayProjectDeletionIntents(
  database: Database,
  journal: ProjectDeletionJournal,
  intents: ProjectDeletionIntent[],
  dependencies: Omit<ReclaimDependencies, "journal"> & { reclaim?: boolean },
): Promise<ReplayOutcome> {
  await validateProjectDeletionReplay(database, intents)
  const now = dependencies.now ?? (() => new Date())
  const repository = new ProjectRepository(database, now)
  const outcomes: ReplayOutcome = { projects: intents.length, revoked: 0, tombstones: 0, reclaimed: 0, pending: 0, skippedTables: [] }
  for (const intent of intents) {
    const project = await repository.findAny(intent.projectId)
    if (!project) {
      // Row absent (older/later backup or already reclaimed): tombstone only.
      const existing = await readDeletionRecord(database, intent.projectId)
      if (!existing) {
        await database.transaction(connection => connection.query(
          "INSERT INTO equilens_project_deletions(id,project_id,intent_id,reason,state,requested_by,requested_at,retention_until,attempts,last_error,completed_at,cleared_at) VALUES($1,$2,$3,$4,'reclaimed',$5,$6,$7,0,NULL,$8,$9)",
          [randomUUID(), intent.projectId, intent.id, intent.reason, intent.requestedBy, intent.requestedAt, intent.retentionUntil, now().toISOString(), now().toISOString()],
        ))
      } else if (existing.state !== "reclaimed") {
        await database.transaction(connection => connection.query(
          "UPDATE equilens_project_deletions SET state='reclaimed',last_error=NULL,completed_at=$1,cleared_at=$2 WHERE project_id=$3 AND state IN ('requested','failed','reclaiming')",
          [now().toISOString(), now().toISOString(), intent.projectId],
        ))
      }
      outcomes.tombstones++
      continue
    }
    // The restored project row must never stay visible; revoke before any cleanup.
    if (project.status === "active") {
      await database.transaction(async connection => {
        await connection.query("UPDATE equilens_projects SET status='deleted',deleted_at=$1,updated_at=$2,revision=revision+1 WHERE id=$3 AND status='active'", [now().toISOString(), now().toISOString(), intent.projectId])
      })
      outcomes.revoked++
    }
    const existing = await readDeletionRecord(database, intent.projectId)
    if (!existing) {
      await database.transaction(connection => connection.query(
        "INSERT INTO equilens_project_deletions(id,project_id,intent_id,reason,state,requested_by,requested_at,retention_until,attempts,last_error,completed_at,cleared_at) VALUES($1,$2,$3,$4,'requested',$5,$6,$7,0,NULL,NULL,NULL)",
        [randomUUID(), intent.projectId, intent.id, intent.reason, intent.requestedBy, intent.requestedAt, intent.retentionUntil],
      ))
    } else if (existing.state === "reclaimed") {
      if (project.status !== "active") continue // already revoked+reclaimed: idempotent no-op
      // A restored row makes the project visible again: re-delete before cleanup.
      await resetTombstoneForReplay(database, intent.projectId)
    }
    if (dependencies.reclaim === false) continue
    const outcome = await reclaimProject(database, intent.projectId, { ...dependencies, journal, now })
    if (outcome.state === "reclaimed") outcomes.reclaimed++
    else outcomes.pending++
    outcomes.skippedTables.push(...outcome.skippedTables)
  }
  return outcomes
}

/**
 * Reconcile legacy `status='deleted'` projects that have no deletion record:
 * create the requested record + journal intent (auditable) and reclaim. Never
 * re-activates a project.
 */
export async function reconcileRecordlessDeletedProjects(
  database: Database,
  journal: ProjectDeletionJournal,
  dependencies: { store: PrivateObjectStore; now?: () => Date; batch?: number; maxBatches?: number; actor?: string; reclaim?: boolean },
): Promise<{ reconciled: number; failed: number; skippedTables: string[] }> {
  const now = dependencies.now ?? (() => new Date())
  const repository = new ProjectRepository(database, now)
  const projects = await repository.listRecordlessDeleted(100)
  let reconciled = 0
  let failed = 0
  const skippedTables: string[] = []
  for (const project of projects) {
    try {
      const { record } = await repository.delete(project.id, dependencies.actor ?? "system:reconcile", "admin-remove")
      await journal.appendIntent(intentFromRecord(record, project))
      if (dependencies.reclaim !== false) {
        const outcome = await reclaimProject(database, project.id, {
          journal, store: dependencies.store, ...(dependencies.now ? { now: dependencies.now } : {}),
          ...(dependencies.batch !== undefined ? { batch: dependencies.batch } : {}),
          ...(dependencies.maxBatches !== undefined ? { maxBatches: dependencies.maxBatches } : {}),
        })
        skippedTables.push(...outcome.skippedTables)
        if (outcome.state !== "reclaimed") failed++
      }
      reconciled++
    } catch {
      failed++
    }
  }
  return { reconciled, failed, skippedTables }
}

/** Table names that are project-scoped per the runtime schemas but absent in this build. */
export function pendingRuntimeTables(skipped: string[]): string[] {
  return skipped.filter(table => (PROJECT_RUNTIME_TABLES as readonly string[]).includes(table))
}

export type { ProjectDeletionReason }
