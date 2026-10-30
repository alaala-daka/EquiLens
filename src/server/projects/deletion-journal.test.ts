import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import {
  createProjectDeletionJournal,
  validateProjectDeletionIntent,
  validateProjectDeletionIntents,
  type ProjectDeletionIntent,
} from "./deletion-journal"

const projectId = "11111111-1111-4111-8111-111111111111"

const intent = (overrides: Partial<ProjectDeletionIntent> = {}): ProjectDeletionIntent => ({
  version: 1,
  id: "22222222-2222-4222-8222-222222222222",
  projectId,
  reason: "user-delete",
  requestedBy: "33333333-3333-4333-8333-333333333333",
  requestedAt: "2026-10-29T00:00:00.000Z",
  retentionUntil: "2026-12-31",
  ...overrides,
})

/**
 * Windows cannot fsync a directory (EPERM); the anonymous retention journal has
 * the same platform boundary and keeps a Linux-only durability test. Logical
 * C7 journal tests inject the directory barrier here; real Linux fsync evidence
 * remains a separate unrun platform item.
 */
const logicalFilesystem = { async openDirectory() { return { async sync() {}, async close() {} } } }

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "equilens-project-journal-"))
}

test("C7 journal: strict exact-field validation rejects extra/missing fields and bad values", () => {
  const valid = intent()
  assert.doesNotThrow(() => validateProjectDeletionIntent(valid))
  validateProjectDeletionIntents([valid])
  for (const rejected of [
    { ...valid, extra: true },
    { ...valid, version: 2 },
    { ...valid, id: "not-a-uuid" },
    { ...valid, projectId: "not-a-uuid" },
    { ...valid, reason: "anonymous-expired" },
    { ...valid, requestedBy: "" },
    { ...valid, requestedAt: "2026-10-29" },
    { ...valid, retentionUntil: "31-12-2026" },
  ]) assert.throws(() => validateProjectDeletionIntent(rejected), /Invalid project deletion journal/)
  assert.throws(() => validateProjectDeletionIntent("json string"), /Invalid project deletion journal/)
  assert.throws(() => validateProjectDeletionIntent(null), /Invalid project deletion journal/)
})

test("C7 journal: whole-batch validation rejects duplicate ids and conflicting per-project intents", () => {
  const first = intent()
  assert.throws(() => validateProjectDeletionIntents([first, { ...first }]), /Conflicting project deletion journal/)
  assert.throws(() => validateProjectDeletionIntents([first, intent({ id: "44444444-4444-4444-8444-444444444444", requestedAt: "2026-10-30T00:00:00.000Z" })]), /Conflicting project deletion journal/)
  assert.throws(() => validateProjectDeletionIntents([first, intent({ id: "44444444-4444-4444-8444-444444444444", retentionUntil: "2027-01-31" })]), /Conflicting project deletion journal/)
  assert.throws(() => validateProjectDeletionIntents([first, intent({ id: "44444444-4444-4444-8444-444444444444" })]), /Conflicting project deletion journal/)
  validateProjectDeletionIntents([first, intent({ id: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" })])
})

test("C7 journal: append writes one atomically renamed file and is idempotent for the same project", async () => {
  const directory = await temporaryDirectory()
  try {
    const journal = createProjectDeletionJournal(directory, logicalFilesystem)
    const value = intent()
    await journal.appendIntent(value)
    const names = await readdir(directory)
    assert.deepEqual(names, [`${value.id}.json`])
    assert.equal(JSON.parse(await readFile(join(directory, names[0]), "utf8")).projectId, projectId)
    assert.equal(names.some(name => name.includes(".tmp-")), false)
    // Identical re-append is a no-op (runtime retries the same intent).
    await journal.appendIntent(value)
    // Same project with changed content conflicts.
    await assert.rejects(journal.appendIntent({ ...value, requestedAt: "2026-10-30T00:00:00.000Z" }), /Conflicting project deletion journal/)
    // Same intent id claimed by another project conflicts.
    await assert.rejects(journal.appendIntent({ ...value, projectId: "66666666-6666-4666-8666-666666666666" }), /Conflicting project deletion journal/)
    assert.deepEqual(await journal.readIntents(), [value])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("C7 journal: read validates file names, JSON, exact fields and conflicting duplicates", async () => {
  const directory = await temporaryDirectory()
  try {
    const journal = createProjectDeletionJournal(directory, logicalFilesystem)
    await writeFile(join(directory, "not-a-uuid.json"), JSON.stringify(intent()))
    await assert.rejects(journal.readIntents(), /Invalid deletion journal filename/)
    await rm(join(directory, "not-a-uuid.json"))
    await writeFile(join(directory, `${intent().id}.json`), "{")
    await assert.rejects(journal.readIntents())
    await writeFile(join(directory, `${intent().id}.json`), JSON.stringify({ ...intent(), extra: 1 }))
    await assert.rejects(journal.readIntents(), /Invalid project deletion journal/)
    await writeFile(join(directory, `${intent().id}.json`), JSON.stringify(intent()))
    await writeFile(join(directory, "77777777-7777-4777-8777-777777777777.json"), JSON.stringify(intent({ id: "77777777-7777-4777-8777-777777777777", requestedAt: "2026-10-30T00:00:00.000Z" })))
    await assert.rejects(journal.readIntents(), /Conflicting project deletion journal/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("C7 journal: a leftover temporary file from a crash is ignored, unknown files are rejected", async () => {
  const directory = await temporaryDirectory()
  try {
    const journal = createProjectDeletionJournal(directory, logicalFilesystem)
    const value = intent()
    await writeFile(join(directory, `${value.id}.json`), JSON.stringify(value))
    await writeFile(join(directory, `${value.id}.json.tmp-abcdef12`), "{")
    assert.deepEqual(await journal.readIntents(), [value])
    await writeFile(join(directory, "README.txt"), "not a journal")
    await assert.rejects(journal.readIntents(), /Invalid deletion journal filename/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("C7 journal: a public directory is rejected before any file is written", () => {
  assert.throws(() => createProjectDeletionJournal(resolve("public", "project-journal")), /Invalid deletion journal directory/)
})

test("C7 journal: a directory sync failure fails the append closed and a retry redoes the barrier", async () => {
  const directory = await temporaryDirectory()
  try {
    let failing = true
    let barrierCalls = 0
    const injectable = createProjectDeletionJournal(directory, {
      async openDirectory() {
        barrierCalls++
        return { async sync() { if (failing) throw new Error("synthetic directory sync failure") }, async close() {} }
      },
    })
    await assert.rejects(injectable.appendIntent(intent()), /synthetic directory sync failure/)
    assert.ok(barrierCalls > 0)
    // The intent file may already exist after the failed barrier; readiness must
    // not skip the barrier, so reads keep failing until a successful retry.
    await assert.rejects(injectable.readIntents(), /synthetic directory sync failure/)
    failing = false
    const healthy = createProjectDeletionJournal(directory, logicalFilesystem)
    await healthy.appendIntent(intent())
    assert.equal((await healthy.readIntents()).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("C7 journal: real Linux file+directory fsync persists and reopens", { skip: process.platform !== "linux" ? "Linux file and directory fsync evidence required; Windows logical tests use injected barriers" : false }, async () => {
  const directory = await temporaryDirectory()
  try {
    const journal = createProjectDeletionJournal(directory)
    await journal.appendIntent(intent())
    const reopened = createProjectDeletionJournal(directory)
    await reopened.appendIntent(intent())
    assert.deepEqual(await reopened.readIntents(), [intent()])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
