import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { DocumentSessionRepository } from "./session-repository"
import { DocumentRepository } from "./repository"
import { blankDocx } from "../../lib/documents/docx"
import { cleanExpiredSessions } from "./retention-cleanup"
import { inspectRetention, writeInventory, enrollRetention, replayRetention } from "./retention-maintenance"
import type { DeletionIntent } from "./retention-journal"

const owner = (s: string) => createHash("sha256").update(s).digest("hex")
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-maintenance-"))
  const path = join(directory, "restored.sqlite")
  const sqlite = new DatabaseSync(path)
  const originalBytes = Buffer.from(await blankDocx().arrayBuffer())
  const originalHash = createHash("sha256").update(originalBytes).digest("hex")
  sqlite.exec("CREATE TABLE equilens_schema(version INTEGER PRIMARY KEY); INSERT INTO equilens_schema VALUES(1); CREATE TABLE equilens_documents(owner TEXT,id TEXT,current_revision TEXT,metadata TEXT,PRIMARY KEY(owner,id)); CREATE TABLE equilens_revisions(owner TEXT,id TEXT,document_id TEXT,metadata TEXT,payload TEXT,PRIMARY KEY(owner,id));")
  for (const key of [owner("legacy"), owner("independent-copy")]) {
    for (const [index, createdAt] of ["2026-01-01T01:00:00+02:00", "2026-01-01T00:00:00Z"].entries()) {
      sqlite.prepare("INSERT INTO equilens_documents VALUES(?,?,?,?)").run(key, `doc${index}`, `rev${index}`, JSON.stringify({ id: `doc${index}`, currentRevision: `rev${index}`, createdAt, updatedAt: createdAt, source: "imported", title: "PRIVATE TITLE", prompt: "PRIVATE PROMPT" }))
      sqlite.prepare("INSERT INTO equilens_revisions VALUES(?,?,?,?,?)").run(key, `rev${index}`, `doc${index}`, JSON.stringify({ id: `rev${index}`, documentId: `doc${index}`, parentId: null, hash: originalHash, createdAt, editorVersion: "synthetic-v1", templateVersion: null }), originalBytes.toString("base64"))
    }
  }
  sqlite.close()
  const database = await connectDatabase({ provider: "sqlite", path })
  let clock = new Date("2026-02-01T00:00:00.000Z")
  const sessions = new DocumentSessionRepository(database, { now: () => clock, readPolicy: () => null })
  const input = { owner: owner("legacy"), retentionDays: 2, exportUntil: "2026-02-03T00:00:00.000Z", notifiedAt: clock.toISOString(), operator: "synthetic operator", purpose: "synthetic migration" }
  const snapshot = () => database.transaction(async c => ({ docs: (await c.query("SELECT * FROM equilens_documents ORDER BY owner,id")).rows, revisions: (await c.query("SELECT * FROM equilens_revisions ORDER BY owner,id")).rows, sessions: (await c.query("SELECT * FROM equilens_document_sessions ORDER BY owner")).rows }))
  return { directory, path, database, sessions, input, snapshot, originalHash, documents: new DocumentRepository(database, sessions), now: () => clock, setNow(s: string) { clock = new Date(s) }, async close() { await database.close(); await rm(directory, { recursive: true }) } }
}

test("DB-08: inspect parses actual earliest timestamp and writes exclusive private inventory without registering", async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot(), inventory = await inspectRetention(f.database)
    assert.equal(inventory.length, 2)
    assert.deepEqual(inventory[0], { owner: inventory[0].owner, firstCreatedAt: "2025-12-31T23:00:00.000Z", documentCount: 2, revisionCount: 2, registrationState: "legacy_pending" })
    const output = join(f.directory, "inventory.json")
    await writeInventory(output, inventory)
    const bytes = await readFile(output, "utf8")
    assert.doesNotMatch(bytes, /PRIVATE/)
    await assert.rejects(writeInventory(output, inventory))
    await assert.rejects(writeInventory("public/private-inventory.json", inventory))
    assert.deepEqual(await f.snapshot(), before)
  } finally { await f.close() }
})

test("DB-08: enroll validates full batch before writes, dry run stays readonly, replay is canonical and conflict safe", async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    const other = { ...f.input, owner: owner("independent-copy") }
    for (const invalid of [{ ...other, owner: owner("unknown") }, { ...other, notifiedAt: undefined }, { ...other, exportUntil: "2026-01-01" }, { ...other, retentionDays: 0 }, { ...other, retentionDays: 1.5 }, { ...other, operator: " " }, f.input]) {
      await assert.rejects(enrollRetention(f.sessions, [f.input, invalid], true))
      assert.deepEqual(await f.snapshot(), before)
    }
    assert.equal(await enrollRetention(f.sessions, [f.input], false), 1)
    assert.deepEqual(await f.snapshot(), before)
    await enrollRetention(f.sessions, [f.input], true)
    const registered = await f.snapshot()
    await enrollRetention(f.sessions, [{ ...f.input, notifiedAt: "2026-02-01T08:00:00+08:00" }], true)
    assert.deepEqual(await f.snapshot(), registered)
    await assert.rejects(enrollRetention(f.sessions, [{ ...f.input, retentionDays: 3 }], true), { status: 409 })
    assert.deepEqual((await f.snapshot()).docs, before.docs)
    assert.deepEqual((await f.snapshot()).revisions, before.revisions)
    assert.equal((await f.sessions.view(f.input.owner)).state, "legacy_export")
    await f.sessions.assertAccess(f.input.owner, "download")
    const opened = await f.documents.open(f.input.owner, "doc0")
    assert.equal(createHash("sha256").update(Buffer.from(await opened.revision.blob.arrayBuffer())).digest("hex"), f.originalHash)
    await assert.rejects(f.documents.save(f.input.owner, { documentId: "doc0", baseRevision: "rev0", operationId: randomUUID(), title: "change", prompt: "change", blob: blankDocx() }), { status: 403 })
    await assert.rejects(f.documents.create(f.input.owner, { title: "change", prompt: "change", source: "authored", blob: blankDocx() }), { status: 403 })
    await assert.rejects(f.documents.create(f.input.owner, { title: "copy", prompt: "", source: "copy", blob: blankDocx(), copiedFrom: { documentId: "doc0", revisionId: "rev0" } }), { status: 403 })
    for (const action of ["save", "create", "copy"] as const) await assert.rejects(f.sessions.assertAccess(f.input.owner, action), { status: 403 })
    f.setNow(f.input.exportUntil)
    await assert.rejects(f.sessions.assertAccess(f.input.owner, "read"), { status: 410 })
    await enrollRetention(f.sessions, [f.input], true)
    const journal = { intents: [] as DeletionIntent[], async readIntents() { return this.intents }, async appendIntent(intent: DeletionIntent) { this.intents.push(intent) } }
    assert.deepEqual(await cleanExpiredSessions(f.database, f.sessions, journal, f.now), { deleted: 1, failed: 0 })
    assert.deepEqual((await f.snapshot()).docs, before.docs.filter(row => row.owner !== f.input.owner))
    assert.deepEqual((await f.snapshot()).revisions, before.revisions.filter(row => row.owner !== f.input.owner))
  } finally { await f.close() }
})

test("DB-08: replay checks complete journal digests/target before shared deletion; dryrun and invalid batch do not delete", async () => {
  const f = await fixture()
  try {
    const intent: DeletionIntent = { id: randomUUID(), owner: f.input.owner, expiresAt: "2026-01-03T00:00:00.000Z", requestedAt: "2026-02-01T00:00:00.000Z", reason: "anonymous-expired" }
    const journalPath = join(f.directory, "journal")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(journalPath)
    const bytes = JSON.stringify(intent), name = `${intent.id}.json`
    await writeFile(join(journalPath, name), bytes)
    const target = { provider: "sqlite" as const, path: f.path }
    const manifest = { version: 1, target, files: [{ name, sha256: createHash("sha256").update(bytes).digest("hex") }] }
    const before = await f.snapshot()
    const journal = { async readIntents() { return [intent] }, async appendIntent() {} }
    assert.equal(await replayRetention(f.database, journalPath, manifest, target, false), 1)
    assert.deepEqual(await f.snapshot(), before)
    await assert.rejects(replayRetention(f.database, journalPath, manifest, target, true, false, journal))
    for (const invalid of [{ ...manifest, files: [] }, { ...manifest, target: { ...target, path: "wrong" } }, { ...manifest, files: [{ name, sha256: "0".repeat(64) }] }]) {
      await assert.rejects(replayRetention(f.database, journalPath, invalid, target, true, true, journal))
      assert.deepEqual(await f.snapshot(), before)
    }
    await replayRetention(f.database, journalPath, manifest, target, true, true, journal)
    await replayRetention(f.database, journalPath, manifest, target, true, true, journal)
    assert.equal((await f.sessions.view(intent.owner)).state, "expired")
    const after = await f.snapshot()
    assert.deepEqual(after.docs, before.docs.filter(row => row.owner !== intent.owner))
    assert.deepEqual(after.revisions, before.revisions.filter(row => row.owner !== intent.owner))
  } finally { await f.close() }
})
