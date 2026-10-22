import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { blankDocx } from "../../lib/documents/docx"
import { connectDatabase, type Database } from "../database/connection"
import { DocumentRepository } from "./repository"
import { retentionPolicy } from "./retention-policy"
import { DocumentSessionRepository } from "./session-repository"

const owner = createHash("sha256").update("synthetic retention owner").digest("hex")
const policy = retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" })
async function setup(initial = "2026-10-22T00:00:00.000Z") {
  const directory = await mkdtemp(join(tmpdir(), "equilens-retention-"))
  const config = { provider: "sqlite", path: join(directory, "store.sqlite") } as const
  const database = await connectDatabase(config)
  let current = new Date(initial)
  let currentPolicy: typeof policy | null = policy
  const sessions = new DocumentSessionRepository(database, { now: () => current, readPolicy: () => currentPolicy })
  const repository = new DocumentRepository(database, sessions)
  const create = async (title = "资料") => repository.create(owner, { blob: blankDocx(), title, source: "authored", prompt: "", retentionConsent: (await sessions.view(owner)).confirmation! })
  return { database, config, sessions, repository, create, setTime: (value: string) => { current = new Date(value) }, setPolicy: (value: typeof policy | null) => { currentPolicy = value }, close: async () => { await database.close(); await rm(directory, { recursive: true }) } }
}

test("DB-08: first deadline is fixed across create, copy, save and reopen; exact expiry denies every action", async () => {
  const state = await setup()
  try {
    const empty = await state.sessions.view(owner)
    assert.equal(empty.state, "new")
    assert.equal(empty.expiresAt, null)
    const first = await state.create()
    const deadline = (await state.sessions.view(owner)).expiresAt!
    assert.equal(deadline, "2026-10-24T00:00:00.000Z")
    assert.equal(first.document.createdAt, "2026-10-22T00:00:00.000Z")
    assert.equal(first.revision.createdAt, first.document.createdAt)
    state.setTime("2026-10-23T00:00:00.000Z")
    state.setPolicy(retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "4" }))
    await state.create("第二份")
    await state.repository.create(owner, { blob: blankDocx(), title: "副本", source: "copy", prompt: "", copiedFrom: { documentId: first.document.id, revisionId: first.revision.id } })
    await state.repository.save(owner, { documentId: first.document.id, baseRevision: first.revision.id, operationId: randomUUID(), title: "修订", prompt: "", blob: blankDocx() })
    await state.repository.open(owner, first.document.id)
    assert.equal((await state.sessions.view(owner)).expiresAt, deadline)
    state.setTime(deadline)
    for (const action of ["read", "download", "save", "create", "copy"] as const) {
      await assert.rejects(state.database.transaction(connection => state.sessions.guardIn(connection, owner, action)), { status: 410, code: "RETENTION_EXPIRED" })
    }
    await assert.rejects(state.repository.open(owner, first.document.id), { status: 410 })
    await assert.rejects(state.repository.list(owner), { status: 410 })
    assert.deepEqual((await state.sessions.expiredOwners(10)).map(record => record.owner), [owner])
  } finally { await state.close() }
})

test("DB-08: missing policy and stale midnight consent leave no documents or fixed deadline", async () => {
  const state = await setup("2026-10-22T15:59:59.000Z")
  try {
    const consent = (await state.sessions.view(owner)).confirmation!
    state.setTime("2026-10-22T16:00:00.000Z")
    await assert.rejects(state.repository.create(owner, { blob: blankDocx(), title: "跨日", source: "imported", prompt: "", retentionConsent: consent }), { status: 409, code: "RETENTION_CONFIRMATION_CHANGED" })
    await assert.rejects(state.repository.create(owner, { blob: blankDocx(), title: "未确认", source: "authored", prompt: "" }), { status: 422, code: "RETENTION_CONSENT_REQUIRED" })
    state.setPolicy(null)
    await assert.rejects(state.create(), { status: 503, code: "RETENTION_UNCONFIGURED" })
    assert.equal((await state.sessions.view(owner)).expiresAt, null)
    await state.database.transaction(async connection => {
      assert.equal((await connection.query("SELECT id FROM equilens_documents")).rows.length, 0)
      assert.equal((await connection.query("SELECT id FROM equilens_revisions")).rows.length, 0)
    })
    state.setPolicy(policy)
    const first = await state.create()
    state.setPolicy(null)
    assert.equal((await state.repository.open(owner, first.document.id)).revision.id, first.revision.id)
    await state.repository.save(owner, { documentId: first.document.id, baseRevision: first.revision.id, operationId: randomUUID(), title: "仍可保存", prompt: "", blob: blankDocx() })
    await assert.rejects(state.create(), { status: 503 })
  } finally { await state.close() }
})

test("DB-08: concurrent registration and first creates produce one context and one fixed deadline", async () => {
  const state = await setup()
  try {
    const views = await Promise.all([state.sessions.view(owner), state.sessions.view(owner)])
    assert.equal(views[0].contextId, views[1].contextId)
    const input = { blob: blankDocx(), title: "竞争", source: "authored" as const, prompt: "", retentionConsent: views[0].confirmation! }
    const records = await Promise.all([state.repository.create(owner, input), state.repository.create(owner, input)])
    assert.equal(records.length, 2)
    await state.database.transaction(async connection => {
      const rows = (await connection.query("SELECT * FROM equilens_document_sessions WHERE owner=$1", [owner])).rows
      assert.equal(rows.length, 1)
      assert.equal(rows[0].revision, 1)
      assert.equal(rows[0].first_created_at, records[0].document.createdAt)
      assert.equal(rows[0].expires_at, "2026-10-24T00:00:00.000Z")
      assert.equal(rows[0].registered_at, "2026-10-22T00:00:00.000Z")
    })
    await assert.rejects(state.sessions.assertContext(owner, ""), { status: 400, code: "SESSION_CONTEXT_REQUIRED" })
    await assert.rejects(state.sessions.assertContext(owner, randomUUID()), { status: 409, code: "SESSION_CHANGED" })
    await state.sessions.assertContext(owner, views[0].contextId)
  } finally { await state.close() }
})

test("DB-08: first-document storage failure rolls back its deadline and policy faults remain faults", async () => {
  const state = await setup()
  try {
    const consent = (await state.sessions.view(owner)).confirmation!
    const faulty: Database = { close: () => state.database.close(), transaction: work => state.database.transaction(connection => work({ query(sql, values) {
      if (sql.startsWith("INSERT INTO equilens_revisions")) throw new Error("Synthetic first-document failure")
      return connection.query(sql, values)
    } })) }
    const sessions = new DocumentSessionRepository(faulty, { now: () => new Date("2026-10-22T00:00:00.000Z"), readPolicy: () => policy })
    await assert.rejects(new DocumentRepository(faulty, sessions).create(owner, { blob: blankDocx(), title: "事务", source: "authored", prompt: "", retentionConsent: consent }), /Synthetic first-document failure/)
    assert.equal((await state.sessions.view(owner)).expiresAt, null)
    assert.equal((await state.repository.list(owner)).length, 0)
    const broken = new DocumentSessionRepository(state.database, { now: () => new Date("2026-10-22T00:00:00.000Z"), readPolicy: () => { throw new Error("Synthetic policy source failure") } })
    await assert.rejects(broken.view(owner), /Synthetic policy source failure/)
  } finally { await state.close() }
})

test("DB-08: v1 migration preserves original bytes and history; notified legacy window is read only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-v1-"))
  const config = { provider: "sqlite", path: join(directory, "store.sqlite") } as const
  const sqlite = new DatabaseSync(config.path)
  const payload = Buffer.from(await blankDocx().arrayBuffer()).toString("base64")
  const documentId = randomUUID()
  const revisionId = randomUUID()
  const documentMetadata = JSON.stringify({ id: documentId, title: "存量", source: "imported", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", currentRevision: revisionId, originalRevision: revisionId })
  const revisionMetadata = JSON.stringify({ id: revisionId, documentId, hash: createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex"), createdAt: "2026-10-01T00:00:00.000Z" })
  sqlite.exec("CREATE TABLE equilens_schema(version INTEGER PRIMARY KEY); INSERT INTO equilens_schema VALUES(1); CREATE TABLE equilens_documents(owner VARCHAR(64),id VARCHAR(36),current_revision VARCHAR(36),metadata TEXT,PRIMARY KEY(owner,id)); CREATE TABLE equilens_revisions(owner VARCHAR(64),id VARCHAR(36),document_id VARCHAR(36),metadata TEXT,payload TEXT,PRIMARY KEY(owner,id));")
  sqlite.prepare("INSERT INTO equilens_documents VALUES(?,?,?,?)").run(owner, documentId, revisionId, documentMetadata)
  sqlite.prepare("INSERT INTO equilens_revisions VALUES(?,?,?,?,?)").run(owner, revisionId, documentId, revisionMetadata, payload)
  sqlite.close()
  const database = await connectDatabase(config)
  let current = new Date("2026-10-22T00:00:00.000Z")
  const sessions = new DocumentSessionRepository(database, { now: () => current, readPolicy: () => policy })
  const repository = new DocumentRepository(database, sessions)
  try {
    assert.equal((await sessions.view(owner)).state, "legacy_pending")
    await assert.rejects(repository.list(owner), { status: 503, code: "LEGACY_RETENTION_PENDING" })
    await database.transaction(async connection => {
      assert.equal((await connection.query("SELECT version FROM equilens_schema")).rows[0].version, 2)
      assert.deepEqual({ ...(await connection.query("SELECT metadata,payload FROM equilens_revisions")).rows[0] }, { metadata: revisionMetadata, payload })
      assert.equal((await connection.query("SELECT metadata FROM equilens_documents")).rows[0].metadata, documentMetadata)
    })
    await assert.rejects(sessions.registerLegacy({ owner, retentionDays: 2, exportUntil: "2026-10-24T00:00:00.000Z", notifiedAt: "2026-10-23T00:00:00.000Z", operator: "synthetic operator", purpose: "synthetic migration" }))
    const registration = { owner, retentionDays: 2, exportUntil: "2026-10-24T00:00:00.000Z", notifiedAt: current.toISOString(), operator: "synthetic operator", purpose: "synthetic migration" }
    await sessions.registerLegacy(registration)
    await sessions.registerLegacy(registration)
    await assert.rejects(sessions.registerLegacy({ ...registration, retentionDays: 3 }), { status: 409 })
    await database.transaction(async connection => {
      assert.equal((await connection.query("SELECT revision FROM equilens_document_sessions WHERE owner=$1", [owner])).rows[0].revision, 1)
    })
    assert.equal((await sessions.view(owner)).state, "legacy_export")
    assert.equal((await repository.list(owner)).length, 1)
    assert.equal(Buffer.from(await (await repository.open(owner, documentId)).revision.blob.arrayBuffer()).toString("base64"), payload)
    await assert.rejects(repository.create(owner, { blob: blankDocx(), title: "禁止", source: "copy", prompt: "", copiedFrom: { documentId, revisionId } }), { status: 403, code: "RETENTION_READ_ONLY" })
    current = new Date("2026-10-24T00:00:00.000Z")
    await assert.rejects(repository.list(owner), { status: 410 })
    await database.transaction(connection => connection.query("UPDATE equilens_document_sessions SET revoked_at=$1 WHERE owner=$2", [current.toISOString(), owner]))
    assert.equal((await sessions.view(owner)).state, "expired")
  } finally { await database.close(); await rm(directory, { recursive: true }) }
})

test("DB-08: unknown schema is refused without rewriting its version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-unknown-"))
  const path = join(directory, "store.sqlite")
  const sqlite = new DatabaseSync(path)
  sqlite.exec("CREATE TABLE equilens_schema(version INTEGER PRIMARY KEY); INSERT INTO equilens_schema VALUES(42)")
  sqlite.close()
  try { await assert.rejects(connectDatabase({ provider: "sqlite", path }), /Unsupported database schema/) }
  finally { await rm(directory, { recursive: true }) }
})
