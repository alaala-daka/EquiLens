import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { connectDatabase } from "./connection"

test("maintenance read-only connection preserves the original database bytes and never initializes schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "equilens-readonly-"))
  const path = join(root, "snapshot.sqlite")
  try {
    const seed = new DatabaseSync(path)
    seed.exec("CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('saved')")
    seed.close()
    const before = await readFile(path)
    const database = await connectDatabase({ provider: "sqlite", path }, { readOnly: true })
    try {
      const result = await database.transaction(connection => connection.query("SELECT value FROM synthetic"))
      assert.equal(result.rows[0].value, "saved")
      await assert.rejects(database.transaction(connection => connection.query("DELETE FROM synthetic")), /Read-only/)
      const tables = await database.transaction(connection => connection.query("SELECT name FROM sqlite_master WHERE type='table'"))
      assert.deepEqual(tables.rows.map(row => row.name), ["synthetic"])
    } finally { await database.close() }
    assert.deepEqual(await readFile(path), before)
    await assert.rejects(connectDatabase({ provider: "sqlite", path: join(root, "missing.sqlite") }, { readOnly: true }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
