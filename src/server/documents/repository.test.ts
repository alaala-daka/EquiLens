import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase, type Database } from "../database/connection"
import { DocumentRepository } from "./repository"
import { blankDocx } from "../../lib/documents/docx"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"

const sessionOptions = { now: () => new Date("2026-10-22T00:00:00.000Z"), readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }) }

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-db-"))
  const config = { provider: "sqlite", path: join(directory, "store.sqlite") } as const
  const database = await connectDatabase(config)
  const sessions = new DocumentSessionRepository(database, sessionOptions)
  return { directory, config, database, sessions, repository: new DocumentRepository(database, sessions) }
}
const owner = createHash("sha256").update("synthetic owner").digest("hex")
const other = createHash("sha256").update("synthetic other").digest("hex")

test("DB-01: SQLite survives reopen and retains original and immutable versions", async () => {
  const state = await setup()
  let database = state.database
  try {
    const original = blankDocx()
    const initial = await state.repository.create(owner, { blob: original, title: "原件", source: "imported", fileName: "合同.docx", prompt: "", retentionConsent: (await state.sessions.view(owner)).confirmation! })
    const saved = await state.repository.save(owner, { documentId: initial.document.id, baseRevision: initial.revision.id, operationId: randomUUID(), title: "人工修订", prompt: "输入", blob: blankDocx() })
    await database.close()
    database = await connectDatabase(state.config)
    const repository = new DocumentRepository(database, new DocumentSessionRepository(database, sessionOptions))
    const reopened = await repository.open(owner, initial.document.id)
    assert.equal(reopened.revision.id, saved.revision.id)
    assert.deepEqual(await reopened.revision.blob.arrayBuffer(), await saved.revision.blob.arrayBuffer())
    await database.transaction(async connection => {
      const { rows } = await connection.query("SELECT metadata,payload FROM equilens_revisions WHERE owner=$1 AND id=$2", [owner, initial.revision.id])
      assert.equal(JSON.parse(String(rows[0].metadata)).hash, initial.revision.hash)
      assert.equal(String(rows[0].payload), Buffer.from(await original.arrayBuffer()).toString("base64"))
      assert.equal((reopened.document as unknown as { originalRevision: string }).originalRevision, initial.revision.id)
    })
  } finally { await database.close(); await rm(state.directory, { recursive: true }) }
})

test("DB-02: competing updates have one winner, idempotence binds payload, failed writes roll back", async () => {
  const state = await setup()
  try {
    const initial = await state.repository.create(owner, { blob: blankDocx(), title: "并发", source: "authored", prompt: "", retentionConsent: (await state.sessions.view(owner)).confirmation! })
    const inputs = ["甲", "乙"].map(title => ({ documentId: initial.document.id, baseRevision: initial.revision.id, operationId: randomUUID(), title, prompt: "", blob: blankDocx() }))
    const results = await Promise.allSettled(inputs.map(input => state.repository.save(owner, input)))
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const winner = inputs[results.findIndex(result => result.status === "fulfilled")]
    assert.equal((await state.repository.save(owner, winner)).revision.id, winner.operationId)
    await assert.rejects(state.repository.save(owner, { ...winner, prompt: "different" }), { status: 409 })
    const faulty: Database = { close: () => state.database.close(), transaction: work => state.database.transaction(connection => work({ query(sql, values) {
      if (sql.startsWith("INSERT INTO equilens_revisions")) throw new Error("Synthetic disk failure")
      return connection.query(sql, values)
    } })) }
    const operationId = randomUUID()
    await assert.rejects(new DocumentRepository(faulty, new DocumentSessionRepository(faulty, sessionOptions)).save(owner, { ...winner, baseRevision: winner.operationId, operationId, title: "回滚" }), /Synthetic/)
    assert.equal((await state.repository.open(owner, initial.document.id)).revision.id, winner.operationId)
    await state.database.transaction(async connection => {
      assert.equal((await connection.query("SELECT id FROM equilens_revisions WHERE owner=$1 AND id=$2", [owner, operationId])).rows.length, 0)
    })
  } finally { await state.database.close(); await rm(state.directory, { recursive: true }) }
})

test("DB-03: session ownership applies to list, read, update and copy provenance", async () => {
  const state = await setup()
  try {
    const initial = await state.repository.create(owner, { blob: blankDocx(), title: "隔离", source: "authored", prompt: "", retentionConsent: (await state.sessions.view(owner)).confirmation! })
    assert.equal((await state.repository.list(other)).length, 0)
    await assert.rejects(state.repository.open(other, initial.document.id), { status: 404 })
    await assert.rejects(state.repository.save(other, { documentId: initial.document.id, baseRevision: initial.revision.id, operationId: randomUUID(), title: "攻击", prompt: "", blob: blankDocx() }), { status: 404 })
    const copiedFrom = { documentId: initial.document.id, revisionId: initial.revision.id }
    await assert.rejects(state.repository.create(other, { blob: blankDocx(), title: "复制", source: "copy", prompt: "", copiedFrom }), { status: 404 })
    const copy = await state.repository.create(owner, { blob: blankDocx(), title: "副本", source: "copy", prompt: "", copiedFrom })
    assert.deepEqual(copy.document.copiedFrom, copiedFrom)
  } finally { await state.database.close(); await rm(state.directory, { recursive: true }) }
})
