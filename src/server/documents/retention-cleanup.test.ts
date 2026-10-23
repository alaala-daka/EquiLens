import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { DatabaseSync, backup } from "node:sqlite"
import { connectDatabase, type Database } from "../database/connection"
import { blankDocx } from "../../lib/documents/docx"
import { DocumentRepository } from "./repository"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"
import { cleanEmptySessions, cleanExpiredSessions, createFileDeletionJournal, createRetentionRuntime, emptySessionRetentionDays, replayDeletionIntents, type DeletionIntent, type DeletionJournal } from "./retention-cleanup"

const owner = (text: string) => createHash("sha256").update(text).digest("hex")
function memoryJournal() {
  const intents: DeletionIntent[] = []
  return { intents, async appendIntent(intent: DeletionIntent) { if (!intents.some(value => value.id === intent.id)) intents.push(intent) }, async readIntents() { return [...intents] } }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-retention-"))
  const path = join(directory, "store.sqlite")
  const database = await connectDatabase({ provider: "sqlite", path })
  let clock = new Date("2026-01-01T00:00:00.000Z")
  const now = () => clock
  const sessions = new DocumentSessionRepository(database, { now, readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }) })
  const documents = new DocumentRepository(database, sessions)
  const create = async (key: string) => documents.create(key, { title: "合成原件", prompt: "合成输入", source: "authored", blob: blankDocx(), retentionConsent: (await sessions.view(key)).confirmation! })
  return { directory, path, database, now, sessions, documents, create, setNow(value: string) { clock = new Date(value) }, async close() { await database.close(); await rm(directory, { recursive: true }) } }
}
const count = (database: Database, table: string, key: string) => database.transaction(async connection => Number((await connection.query(`SELECT COUNT(*) AS count FROM ${table} WHERE owner=$1`, [key])).rows[0].count))

test("DB-08: cleanup removes original, revisions, copy and prompts; latest journal prevents resurrection from consistent SQLite backup", async () => {
  const f = await fixture()
  let restored: Database | undefined
  try {
    const expired = owner("expired"), valid = owner("valid")
    const original = await f.create(expired)
    await f.documents.save(expired, { documentId: original.document.id, baseRevision: original.revision.id, operationId: randomUUID(), title: "修订", prompt: "秘密输入", blob: blankDocx() })
    await f.documents.create(expired, { title: "副本", prompt: "输入", source: "copy", blob: blankDocx(), copiedFrom: { documentId: original.document.id, revisionId: original.revision.id } })
    f.setNow("2026-01-02T00:00:00.000Z")
    const other = await f.create(valid)
    const before = await f.database.transaction(async c => (await c.query("SELECT metadata,payload FROM equilens_revisions WHERE owner=$1", [valid])).rows)
    const source = new DatabaseSync(f.path)
    try { await backup(source, join(f.directory, "backup.sqlite")) } finally { source.close() }
    f.setNow("2026-01-03T00:00:00.000Z")
    const journal = memoryJournal()
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 1, failed: 0 })
    assert.equal(await count(f.database, "equilens_documents", expired), 0)
    assert.equal(await count(f.database, "equilens_revisions", expired), 0)
    assert.equal(await count(f.database, "equilens_retention_deletions", expired), 1)
    assert.deepEqual(await f.database.transaction(async c => (await c.query("SELECT metadata,payload FROM equilens_revisions WHERE owner=$1", [valid])).rows), before)
    assert.equal((await f.documents.open(valid, other.document.id)).revision.hash, other.revision.hash)
    restored = await connectDatabase({ provider: "sqlite", path: join(f.directory, "backup.sqlite") })
    await replayDeletionIntents(restored, journal)
    await replayDeletionIntents(restored, journal)
    const restoredSessions = new DocumentSessionRepository(restored, { now: () => new Date("2026-01-01T00:00:00.000Z"), readPolicy: () => null })
    await assert.rejects(new DocumentRepository(restored, restoredSessions).open(expired, original.document.id), { status: 410 })
    assert.equal(await count(restored, "equilens_revisions", expired), 0)
  } finally { await restored?.close(); await f.close() }
})

test("DB-08: journal failure prevents DELETE; failed transaction rolls back and retries with the same intent", async () => {
  const f = await fixture()
  try {
    const key = owner("failures")
    await f.create(key)
    f.setNow("2026-01-03T00:00:00.000Z")
    const unavailable: DeletionJournal = { async readIntents() { return [] }, async appendIntent() { throw new Error("synthetic unavailable journal") } }
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, unavailable, f.now), { deleted: 0, failed: 1 })
    assert.equal(await count(f.database, "equilens_documents", key), 1)
    await assert.rejects(f.documents.list(key), { status: 410 })
    const journal = memoryJournal()
    const faulty: Database = { close: async () => {}, transaction: work => f.database.transaction(c => work({ query(sql, values) { if (sql.startsWith("DELETE FROM equilens_documents")) throw new Error("synthetic DELETE failure"); return c.query(sql, values) } })) }
    assert.deepEqual(await cleanExpiredSessions(faulty, f.sessions, journal, f.now), { deleted: 0, failed: 1 })
    assert.equal(await count(f.database, "equilens_revisions", key), 1)
    assert.equal(await count(f.database, "equilens_retention_deletions", key), 0)
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 1, failed: 0 })
    assert.equal(journal.intents.length, 1)
  } finally { await f.close() }
})

test("DB-08: completed first batch does not starve the next batch of over 100 expired owners", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 105; i++) await f.create(owner(`batch-${i}`))
    f.setNow("2026-01-03T00:00:00.000Z")
    const journal = memoryJournal()
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 100, failed: 0 })
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 5, failed: 0 })
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 0, failed: 0 })
    assert.equal(journal.intents.length, 105)
  } finally { await f.close() }
})

test("DB-08: empty rows require an explicit operator window and never erase tombstones or active data", async () => {
  const f = await fixture()
  try {
    const empty = owner("empty"), active = owner("active"), revoked = owner("revoked")
    await f.sessions.view(empty); await f.sessions.view(revoked); await f.create(active)
    await f.database.transaction(c => c.query("UPDATE equilens_document_sessions SET revoked_at=$1 WHERE owner=$2", [f.now().toISOString(), revoked]))
    f.setNow("2026-02-01T00:00:00.000Z")
    assert.equal(emptySessionRetentionDays({}), null)
    for (const value of ["0", "-1", " 1", "1.5", "1e2", "99999999999999999999"]) assert.throws(() => emptySessionRetentionDays({ ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS: value }))
    assert.equal(await cleanEmptySessions(f.database, f.now, null), 0)
    assert.equal(await count(f.database, "equilens_document_sessions", empty), 1)
    assert.equal(await cleanEmptySessions(f.database, f.now, 2), 1)
    assert.equal(await count(f.database, "equilens_document_sessions", empty), 0)
    assert.equal(await count(f.database, "equilens_document_sessions", revoked), 1)
    assert.equal(await count(f.database, "equilens_documents", active), 1)
  } finally { await f.close() }
})

test("DB-08: legacy export window delays physical cleanup until its exact end", async () => {
  const f = await fixture()
  try {
    const key = owner("legacy")
    await f.create(key)
    await f.database.transaction(c => c.query("UPDATE equilens_document_sessions SET export_until=$1 WHERE owner=$2", ["2026-01-05T00:00:00.000Z", key]))
    const journal = memoryJournal()
    f.setNow("2026-01-03T00:00:00.000Z")
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 0, failed: 0 })
    assert.equal((await f.documents.list(key)).length, 1)
    f.setNow("2026-01-05T00:00:00.000Z")
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 1, failed: 0 })
  } finally { await f.close() }
})

test("DB-08: cleanup lifecycle initializes and schedules once, serializes sweeps and waits on stop", async () => {
  let release!: () => void, finish!: () => void, tick!: () => void
  const boot = new Promise<void>(r => { release = r })
  let initializations = 0, registrations = 0, stops = 0, sweeps = 0
  const runtime = createRetentionRuntime({ initialize: async () => { initializations++; await boot }, sweep: async () => { sweeps++; await new Promise<void>(r => { finish = r }) }, schedule: callback => { tick = callback; registrations++; return () => { stops++ } } })
  runtime.start(); runtime.start(); release()
  await runtime.ready()
  tick(); tick()
  assert.equal(initializations, 1); assert.equal(registrations, 1); assert.equal(sweeps, 1)
  let stopped = false
  const stopping = runtime.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  finish(); await stopping
  assert.equal(stops, 1)
})

test("DB-08: startup rejection is safe and retryable; later sweep failure leaves ready usable", async () => {
  let attempts = 0, sweeps = 0, tick!: () => void
  const runtime = createRetentionRuntime({ initialize: async () => { if (++attempts === 1) throw new Error("secret SQL") }, sweep: async () => { sweeps++; throw new Error("secret sweep") }, schedule: callback => { tick = callback; return () => {} } })
  runtime.start()
  await assert.rejects(runtime.ready(), failure => failure instanceof Error && !failure.message.includes("secret"))
  runtime.start(); await runtime.ready()
  await new Promise(r => setImmediate(r))
  tick(); await new Promise(r => setImmediate(r))
  await runtime.ready(); assert.equal(attempts, 2); assert.equal(sweeps, 2)
  await runtime.stop()
})

test("DB-08: journal rejects corrupt records and unsafe filenames before replay or deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-journal-invalid-"))
  try {
    await writeFile(join(directory, `${randomUUID()}.json`), "{partial")
    await assert.rejects(createFileDeletionJournal(directory).readIntents())
    await rm(directory, { recursive: true }); await writeFile(directory, "not a directory")
    await assert.rejects(createFileDeletionJournal(directory).readIntents())
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("DB-08: replay validates every record before changes and creates a denial tombstone if backup predates the session", async () => {
  const f = await fixture()
  try {
    const intent: DeletionIntent = { id: randomUUID(), owner: owner("before-registration"), expiresAt: "2026-01-03T00:00:00.000Z", requestedAt: "2026-01-03T00:00:00.000Z", reason: "anonymous-expired" }
    const journal = memoryJournal()
    journal.intents.push(intent, { ...intent, id: "../../escape" })
    await assert.rejects(replayDeletionIntents(f.database, journal))
    assert.equal(await count(f.database, "equilens_retention_deletions", intent.owner), 0)
    journal.intents.pop()
    await replayDeletionIntents(f.database, journal)
    assert.equal((await f.sessions.view(intent.owner)).state, "expired")
    assert.throws(() => createFileDeletionJournal("public/retention"))
    await assert.rejects(createFileDeletionJournal(join(f.directory, "journal")).appendIntent({ ...intent, id: "../../escape" }))
  } finally { await f.close() }
})

test("DB-08: Linux file journal persists, reopens and reuses a single durable intent", { skip: process.platform !== "linux" ? "Linux file and directory fsync evidence required; Windows logical tests use injected journals" : false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-journal-linux-"))
  try {
    const intent: DeletionIntent = { id: randomUUID(), owner: owner("durable"), expiresAt: "2026-01-03T00:00:00.000Z", requestedAt: "2026-01-03T00:00:00.000Z", reason: "anonymous-expired" }
    await createFileDeletionJournal(directory).appendIntent(intent)
    const reopened = createFileDeletionJournal(directory)
    await reopened.appendIntent(intent)
    assert.deepEqual(await reopened.readIntents(), [intent])
    await writeFile(join(directory, "unsafe.json"), "{}")
    await assert.rejects(reopened.readIntents())
  } finally { await rm(directory, { recursive: true }) }
})

test("DB-08: failed parent directory fsync prevents DELETE and retries all barriers on existing paths", async () => {
  const f = await fixture()
  try {
    const key = owner("parent-directory-fault")
    await f.create(key)
    f.setNow("2026-01-03T00:00:00.000Z")
    const root = resolve(f.directory, "new-parent", "nested", "journal")
    const barriers: string[] = [], closed: string[] = []
    let fail = true, deletes = 0
    const database: Database = { close: async () => {}, transaction: work => f.database.transaction(c => work({ query(sql, values) { if (sql.startsWith("DELETE FROM equilens_documents")) deletes++; return c.query(sql, values) } })) }
    const journal = createFileDeletionJournal(root, { async openDirectory(path) {
      return { async sync() { barriers.push(path); if (fail && path === dirname(root)) throw new Error("synthetic parent fsync failure") }, async close() { closed.push(path) } }
    } })
    assert.deepEqual(await journal.readIntents(), [])
    assert.deepEqual(barriers, []) // Empty startup also works on platforms without directory fsync.
    assert.deepEqual(await cleanExpiredSessions(database, f.sessions, journal, f.now), { deleted: 0, failed: 1 })
    assert.deepEqual(barriers, [root, dirname(root)])
    assert.deepEqual(closed, barriers)
    assert.equal(deletes, 0)
    assert.equal(await count(f.database, "equilens_documents", key), 1)
    assert.equal(await count(f.database, "equilens_revisions", key), 1)
    const names = await readdir(root)
    assert.equal(names.length, 1)
    const intent = JSON.parse(await readFile(join(root, names[0]), "utf8")) as DeletionIntent
    barriers.length = 0; closed.length = 0
    // Already-created directories and the valid intent must not bypass a second failure.
    assert.deepEqual(await cleanExpiredSessions(database, f.sessions, journal, f.now), { deleted: 0, failed: 1 })
    assert.deepEqual(barriers, [root, dirname(root)])
    assert.equal(deletes, 0)
    fail = false; barriers.length = 0; closed.length = 0
    assert.deepEqual(await cleanExpiredSessions(database, f.sessions, journal, f.now), { deleted: 1, failed: 0 })
    const chain = [root]
    while (dirname(chain.at(-1)!) !== chain.at(-1)) chain.push(dirname(chain.at(-1)!))
    assert.deepEqual(barriers.slice(0, chain.length), chain)
    assert.deepEqual(closed, barriers)
    assert.equal(deletes, 1)
    assert.deepEqual(await journal.readIntents(), [intent])
    assert.equal(await count(f.database, "equilens_documents", key), 0)
    assert.equal(await count(f.database, "equilens_revisions", key), 0)
    assert.deepEqual(await cleanExpiredSessions(database, f.sessions, journal, f.now), { deleted: 0, failed: 0 })
    assert.equal(deletes, 1)
  } finally { await f.close() }
})

test("DB-08: existing intent after failed journal-directory fsync blocks replay until a successful retry", async () => {
  const f = await fixture()
  try {
    const key = owner("existing-directory-fault")
    await f.create(key)
    const root = resolve(f.directory, "journal")
    const intent: DeletionIntent = { id: randomUUID(), owner: key, expiresAt: "2026-01-03T00:00:00.000Z", requestedAt: "2026-01-03T00:00:00.000Z", reason: "anonymous-expired" }
    let fail = true, deletes = 0
    const barriers: string[] = []
    const database: Database = { close: async () => {}, transaction: work => f.database.transaction(c => work({ query(sql, values) { if (sql.startsWith("DELETE FROM equilens_documents")) deletes++; return c.query(sql, values) } })) }
    const journal = createFileDeletionJournal(root, { async openDirectory(path) {
      return { async sync() { barriers.push(path); if (fail && path === root) throw new Error("synthetic directory fsync failure") }, async close() {} }
    } })
    await assert.rejects(journal.appendIntent(intent), /synthetic directory fsync failure/)
    assert.deepEqual(JSON.parse(await readFile(join(root, `${intent.id}.json`), "utf8")), intent)
    await assert.rejects(replayDeletionIntents(database, journal), /synthetic directory fsync failure/)
    await assert.rejects(journal.appendIntent(intent), /synthetic directory fsync failure/)
    assert.deepEqual(barriers, [root, root, root])
    assert.equal(deletes, 0)
    assert.equal(await count(f.database, "equilens_documents", key), 1)
    fail = false; barriers.length = 0
    await journal.appendIntent(intent)
    assert.equal(barriers[0], root)
    assert.ok(barriers.includes(dirname(root)))
    await replayDeletionIntents(database, journal)
    assert.equal(deletes, 1)
    assert.equal(await count(f.database, "equilens_documents", key), 0)
    assert.deepEqual(await journal.readIntents(), [intent])
  } finally { await f.close() }
})

test("DB-08: module imports and production-build instrumentation create no SQLite or journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-import-"))
  const oldPath = process.env.SQLITE_PATH, oldRuntime = process.env.NEXT_RUNTIME, oldPhase = process.env.NEXT_PHASE
  try {
    process.env.SQLITE_PATH = join(directory, "absent.sqlite")
    process.env.NEXT_RUNTIME = "nodejs"; process.env.NEXT_PHASE = "phase-production-build"
    const instrumentation = await import("../../instrumentation")
    await instrumentation.register()
    await assert.rejects(access(process.env.SQLITE_PATH))
    await assert.rejects(access(join(directory, "retention-journal")))
    const nextSource = await readFile("node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js", "utf8")
    assert.match(nextSource, /phase-production-build/)
  } finally {
    for (const [key, value] of Object.entries({ SQLITE_PATH: oldPath, NEXT_RUNTIME: oldRuntime, NEXT_PHASE: oldPhase })) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true })
  }
})
