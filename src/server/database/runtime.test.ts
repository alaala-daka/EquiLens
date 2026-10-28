import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase, type Database } from "./connection"
import { migrateBusiness } from "./migrations"
import { createDatabaseHolder } from "./runtime-core"

function fakeDatabase(onClose = () => {}) : Database {
  return { async transaction(work) { return work({ async query() { return { rows: [], changes: 0 } } }) }, async close() { onClose() } }
}

test("database holder is lazy and shares concurrent connections", async () => {
  let calls = 0
  const database = fakeDatabase()
  const holder = createDatabaseHolder(async () => { calls++; return database })
  assert.equal(calls, 0)
  const [first, second] = await Promise.all([holder.get(), holder.get()])
  assert.equal(first, database)
  assert.equal(first, second)
  assert.equal(calls, 1)
  await holder.close()
})

test("database holder shares failure and retries only on a new explicit get", async () => {
  let calls = 0
  const database = fakeDatabase()
  const failure = new Error("synthetic connection failure")
  const holder = createDatabaseHolder(async () => { if (++calls === 1) throw failure; return database })
  const results = await Promise.allSettled([holder.get(), holder.get()])
  assert.deepEqual(results, [{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }])
  assert.equal(calls, 1)
  assert.equal(await holder.get(), database)
  assert.equal(calls, 2)
  await holder.close()
})

test("close waits for an in-flight connection and closes it only once", async () => {
  let closes = 0
  const database = fakeDatabase(() => { closes++ })
  const pending = Promise.withResolvers<Database>()
  const holder = createDatabaseHolder(() => pending.promise)
  const getting = holder.get()
  const closing = holder.close()
  const closingAgain = holder.close()
  assert.equal(closes, 0)
  pending.resolve(database)
  assert.equal(await getting, database)
  await Promise.all([closing, closingAgain])
  await holder.close()
  assert.equal(closes, 1)
  await assert.rejects(holder.get(), /closed/)
})

test("closing an unused or failed holder never opens a connection", async () => {
  let calls = 0
  const holder = createDatabaseHolder(async () => { calls++; throw new Error("synthetic failure") })
  await holder.close()
  assert.equal(calls, 0)
  const failed = createDatabaseHolder(async () => { throw new Error("synthetic failure") })
  await assert.rejects(failed.get())
  await failed.close()
})

test("SQLite anonymous documents and authentication share the held connection", async () => {
  const holder = createDatabaseHolder(() => connectDatabase({ provider: "sqlite", path: ":memory:" }))
  try {
    const documentsDatabase = await holder.get()
    const authenticationDatabase = await holder.get()
    await migrateBusiness(authenticationDatabase)
    await documentsDatabase.transaction(async connection => {
      await connection.query("INSERT INTO equilens_documents(owner,id,current_revision,metadata) VALUES ($1,$2,$3,$4)", ["synthetic-owner", "synthetic-document", "synthetic-revision", "{}"])
      await connection.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision) VALUES ($1,$2,$3,$4,$5)", ["synthetic-account", "synthetic-user", "synthetic-hash", 1, 1])
    })
    await authenticationDatabase.transaction(async connection => {
      assert.equal((await connection.query("SELECT id FROM equilens_documents")).rows[0].id, "synthetic-document")
      assert.equal((await connection.query("SELECT id FROM equilens_auth_accounts")).rows[0].id, "synthetic-account")
    })
  } finally { await holder.close() }
})
