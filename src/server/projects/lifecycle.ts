import { dirname, join, resolve } from "node:path"
import type { Database } from "../database/connection"
import { databaseConfig } from "../database/config"
import { BusinessError } from "./errors"
import {
  createProjectDeletionJournal,
  type ProjectDeletionIntent,
  type ProjectDeletionJournal,
} from "./deletion-journal"
import {
  projectDeletionRecord,
  type ProjectDeletionReason,
  type ProjectDeletionRecord,
} from "./lifecycle-schema"
import type { PrivateObjectStore } from "../storage/obs"
import {
  inspectProjectLifecycle,
  journalIntentForRecord,
  projectObjectStore,
  projectReclaimBatch,
  reclaimPendingProjects,
  reclaimProject,
  reconcileRecordlessDeletedProjects,
  replayProjectDeletionIntents,
  type ReclaimDependencies,
} from "./reclamation"
import { ProjectRepository } from "./repository"

/**
 * C7 project lifecycle runtime (explicit Node.js lifecycle; nothing here runs
 * on import).
 *
 * Startup contract (round-six plan §4.2): `start()` returns immediately so the
 * server/health endpoint is never blocked. A background `initialize()` opens
 * and validates the deletion journal, replays the latest journal before project
 * data becomes visible (restored deleted projects stay deleted), reconciles
 * legacy `deleted`-without-record projects and attempts one bounded reclaim
 * pass; only then is lifecycle `ready`. The production wiring starts the
 * material orphan repair (and the rest of the background chain) only after
 * `projectLifecycleReady()` resolves. Initialization failure keeps the runtime
 * not-ready and every project business entry (access/list/create/task
 * authorization) returns 503; health stays available and does not imply
 * business readiness.
 *
 * `sweep()` first expires authorized projects (access revocation + journal +
 * reclaim) and then retries pending/failed reclamations. It is single-flight,
 * timer `unref`ed, and `stop()` waits for the current short sweep/transaction.
 */
export type ProjectLifecycleRuntimeDependencies = {
  initialize: () => Promise<void>
  sweep: () => Promise<void>
  schedule: (tick: () => void, intervalMs: number) => () => void
  intervalMs?: number
  /** Test hook; production uses the module gate read by access.ts. */
  onReady?: () => void
  onFailure?: () => void
}

export type ProjectLifecycleRuntime = {
  start(): void
  ready(): Promise<void>
  nudge(): void
  sweepNow(): Promise<void>
  stop(): Promise<void>
}

const moduleState = globalThis as typeof globalThis & {
  equilensProjectLifecycleGate?: { ready: boolean; failed: boolean }
  equilensProjectLifecycleRuntime?: ProjectLifecycleRuntime
}

function gate(): { ready: boolean; failed: boolean } {
  return moduleState.equilensProjectLifecycleGate ??= { ready: false, failed: false }
}

/** Fail closed: until lifecycle replay/recovery has completed, project data is unavailable. */
export function requireProjectLifecycleReady(): void {
  if (!gate().ready) throw new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。")
}

export function projectLifecycleAvailable(): boolean {
  return gate().ready
}

/** Readiness for the background startup chain (material repair starts after this resolves). */
export function projectLifecycleReady(): Promise<void> {
  const runtime = moduleState.equilensProjectLifecycleRuntime
  if (!runtime) return Promise.reject(new Error("Project lifecycle runtime has not been started"))
  return runtime.ready()
}

export function projectLifecycleStarted(): boolean {
  return moduleState.equilensProjectLifecycleRuntime !== undefined
}

export function createProjectLifecycleRuntime(dependencies: ProjectLifecycleRuntimeDependencies): ProjectLifecycleRuntime {
  const intervalMs = dependencies.intervalMs ?? 3_600_000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error("Invalid project lifecycle interval")
  const state = gate()
  let started = false
  let cancel: (() => void) | undefined
  let boot: Promise<void> | undefined
  let sweep: Promise<void> | undefined
  let scheduled: ReturnType<typeof setImmediate> | undefined
  let readyPromise: Promise<void>
  let resolveReady!: () => void
  let rejectReady!: (failure: Error) => void
  let failed = false
  function reset() {
    readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    // Instrumentation deliberately does not await ready; always observe rejection internally.
    void readyPromise.catch(() => {})
  }
  reset()
  function tick() {
    if (!started || sweep) return
    sweep = Promise.resolve().then(dependencies.sweep).catch(() => { console.error("Project lifecycle sweep failed") }).finally(() => { sweep = undefined })
  }
  function nudge() {
    if (!started || !state.ready) return
    scheduled ??= setImmediate(() => { scheduled = undefined; tick() })
    scheduled.unref?.()
  }
  return {
    start() {
      if (started || boot) return
      started = true
      state.ready = false
      state.failed = false
      failed = false
      reset()
      boot = Promise.resolve().then(dependencies.initialize).then(() => {
        if (!started || failed) return
        boot = undefined
        state.ready = true
        dependencies.onReady?.()
        cancel = dependencies.schedule(tick, intervalMs)
        resolveReady()
      }).catch(() => {
        boot = undefined
        if (!started) { rejectReady(new Error("Project lifecycle stopped during initialization")); return }
        started = false
        failed = true
        state.ready = false
        state.failed = true
        dependencies.onFailure?.()
        rejectReady(new Error("Project data is temporarily unavailable"))
        console.error("Project lifecycle initialization failed")
      })
    },
    ready() { return readyPromise },
    nudge,
    async sweepNow() { tick(); await sweep },
    async stop() {
      started = false
      state.ready = false
      cancel?.(); cancel = undefined
      if (scheduled) { clearImmediate(scheduled); scheduled = undefined }
      await boot
      await sweep
    },
  }
}

/** Strict env parsing for the frozen configuration boundary (no trim/fallbacks). */
export function projectLifecycleIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PROJECT_LIFECYCLE_INTERVAL_MS
  if (raw === undefined) return 3_600_000
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("Invalid project lifecycle interval configuration")
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 60_000) throw new Error("Invalid project lifecycle interval configuration")
  return value
}

/** Deletion journal directory: explicit for GaussDB; SQLite defaults beside the database. */
export function projectDeletionJournalDirectory(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PROJECT_DELETION_JOURNAL_DIR
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("Invalid project deletion journal directory")
    return resolve(configured)
  }
  const config = databaseConfig(env)
  if (config.provider === "sqlite") return join(dirname(resolve(config.path)), "project-deletion-journal")
  throw new Error("PROJECT_DELETION_JOURNAL_DIR is required for GaussDB")
}

export type ProjectLifecycleContext = {
  database: Database
  journal: ProjectDeletionJournal
  store: PrivateObjectStore
  now: () => Date
  batch: number
}

function reclaimDependencies(context: ProjectLifecycleContext): ReclaimDependencies {
  return { journal: context.journal, store: context.store, now: context.now, batch: context.batch }
}

/**
 * Production wiring: database/journal/object-store resolution happens inside the
 * background initialize, so nothing connects on import and startup stays
 * non-blocking. The Lead's src/instrumentation.ts starts this before the
 * background chain and awaits `projectLifecycleReady()` before material repair.
 */
export function startProjectLifecycleRuntime(env: Record<string, string | undefined> = process.env): void {
  if (moduleState.equilensProjectLifecycleRuntime) return
  const directory = projectDeletionJournalDirectory(env)
  const intervalMs = projectLifecycleIntervalMs(env)
  const batch = projectReclaimBatch(env)
  const now = () => new Date()
  let contextPromise: Promise<ProjectLifecycleContext> | undefined
  const context = () => {
    contextPromise ??= (async () => {
      const databaseRuntime = await import("../database/runtime")
      const database = await databaseRuntime.applicationDatabase()
      return { database, journal: createProjectDeletionJournal(directory), store: projectObjectStore(env), now, batch }
    })().catch(failure => { contextPromise = undefined; throw failure })
    return contextPromise
  }
  const runtime = createProjectLifecycleRuntime({
    intervalMs,
    initialize: async () => {
      const current = await context()
      // Journal replay precedes project visibility: restored deleted projects are
      // revoked (never re-activated) before any business request can see them.
      const intents = await current.journal.readIntents()
      if (intents.length) await replayProjectDeletionIntents(current.database, current.journal, intents, reclaimDependencies(current))
      await reconcileRecordlessDeletedProjects(current.database, current.journal, { ...reclaimDependencies(current), actor: "system:reconcile" })
      await reclaimPendingProjects(current.database, reclaimDependencies(current), current.batch)
    },
    sweep: async () => {
      const current = await context()
      const repository = new ProjectRepository(current.database, current.now)
      const expired = await repository.listExpiredAuthorized(current.now(), current.batch)
      for (const project of expired) {
        try {
          // Revocation + requested record first; access stays revoked even if the
          // journal or object store later fails (retried by the next sweep).
          const { record } = await repository.delete(project.id, "system:retention", "retention-expired")
          await current.journal.appendIntent(journalIntentForRecord(record, project))
          await reclaimProject(current.database, project.id, reclaimDependencies(current))
        } catch {
          console.error("Project retention deletion incomplete")
        }
      }
      await reclaimPendingProjects(current.database, reclaimDependencies(current), current.batch)
    },
    schedule: (tick, ms) => { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer) },
  })
  moduleState.equilensProjectLifecycleRuntime = runtime
  runtime.start()
}

export async function stopProjectLifecycleRuntime(): Promise<void> {
  await moduleState.equilensProjectLifecycleRuntime?.stop()
  moduleState.equilensProjectLifecycleRuntime = undefined
  gate().ready = false
}

/** HTTP DELETE takeover: same-transaction revocation+record, then durable journal intent. */
export async function requestProjectDeletion(input: {
  projectId: string
  actor: string
  reason: ProjectDeletionReason
  env?: Record<string, string | undefined>
}): Promise<ProjectDeletionRecord> {
  const env = input.env ?? process.env
  const directory = projectDeletionJournalDirectory(env)
  const databaseRuntime = await import("../database/runtime")
  const database = await databaseRuntime.applicationDatabase()
  const repository = new ProjectRepository(database)
  let project: Awaited<ReturnType<ProjectRepository["findAny"]>> = null
  try { project = await repository.findAny(input.projectId) } catch { throw new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。") }
  const { record } = await repository.delete(input.projectId, input.actor, input.reason)
  const journal = createProjectDeletionJournal(directory)
  try {
    // No object/row cleanup happens before this durable intent; a failure keeps
    // the project access-revoked and the runtime retries the same intent.
    await journal.appendIntent(journalIntentForRecord(record, project))
  } catch {
    throw new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。")
  }
  moduleState.equilensProjectLifecycleRuntime?.nudge()
  return record
}

/** Redacted state check used by GET /deletion and the private CLI; never returns content. */
export async function projectDeletionRecordFor(database: Database, projectId: string): Promise<ProjectDeletionRecord | null> {
  const { rows } = await database.transaction(connection => connection.query("SELECT * FROM equilens_project_deletions WHERE project_id=$1", [projectId]))
  return rows.length ? projectDeletionRecord(rows[0]) : null
}

export { inspectProjectLifecycle }
export type { ProjectDeletionIntent }
