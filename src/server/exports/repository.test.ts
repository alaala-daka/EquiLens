import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase, type Database } from "../database/connection"
import { statements } from "../results/schema"
import { ExportRepository } from "./repository"

test("conditional terminal transitions reject a lost concurrent update", async () => {
  const database: Database = {
    async close() {},
    async transaction(work) {
      return work({ async query(sql) {
        return sql.startsWith("SELECT") ? { rows: [{ state: "pending" }],changes: 0 } : { rows: [],changes: 0 }
      } })
    },
  }
  const repository = new ExportRepository(database)
  await assert.rejects(repository.abort("p","e"),{ code: "CONFLICT" })
  await assert.rejects(repository.createReady("p","e"),{ code: "CONFLICT" })
})

test("pending intent survives repository recreation and terminal exports stay protected", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => {
      for (const sql of statements) await c.query(sql)
      await c.query("INSERT INTO equilens_results VALUES('r','p','test','v','now')")
      await c.query("INSERT INTO equilens_result_versions VALUES('v','p','r','','op','hash','hash','machine','{}',NULL,NULL,'[]','{}','reason','u','now')")
    })
    const repo = new ExportRepository(db)
    const row = { id: "e",project_id: "p",result_id: "r",version_id: "v",result_sha256: "hash",sha256: "hash",object_key: "key",format: "docx",template_version: "t1",render_version: "r1",snapshot_json: "{}",supersedes_id: null,created_by: "u",created_at: "2026-10-29T00:00:00.000Z",state: "pending",purpose: "result-export",retention_until: "2026-10-30T00:00:00.000Z" }
    await repo.insert(row)
    const restarted = new ExportRepository(db)
    assert.equal((await restarted.pending()).length,1)
    assert.deepEqual(await restarted.list("p","r"),[])
    await assert.rejects(restarted.get("p","r","e"),{ code: "NOT_FOUND" })
    await assert.rejects(restarted.createReady("other","e"),{ code: "NOT_FOUND" })
    await restarted.createReady("p","e")
    assert.equal((await restarted.get("p","r","e")).object_key,"key")
    await assert.rejects(restarted.abort("p","e"),{ code: "CONFLICT" })
    await restarted.insert({ ...row,id: "aborted",object_key: "other-key" })
    await restarted.abort("p","aborted")
    await assert.rejects(restarted.createReady("p","aborted"),{ code: "CONFLICT" })
    assert.equal((await restarted.list("p","r")).length,1)
    assert.equal((await restarted.pending()).length,0)
    for (let i = 0; i < 15; i++) {
      await restarted.insert({ ...row,id: `retry-${i}`,object_key: `retry-key-${i}` })
      await restarted.abort("p",`retry-${i}`)
    }
    const firstBatch = await restarted.aborted()
    assert.equal(firstBatch.length,10)
    const persistentFailure = String(firstBatch[0].id)
    for (const item of firstBatch) {
      await restarted.attempted("p",String(item.id))
      if (item.id !== persistentFailure) await restarted.clear("p",String(item.id))
    }
    const secondBatch = await new ExportRepository(db).aborted()
    assert.ok(secondBatch.some(item => !firstBatch.some(prior => prior.id === item.id)))
    assert.equal(secondBatch.at(-1)?.id,persistentFailure)
    for (const item of secondBatch) if (item.id !== persistentFailure) await restarted.clear("p",String(item.id))
    assert.equal((await restarted.aborted()).length,1)
    assert.equal((await restarted.list("p","r")).length,1)
  } finally { await db.close() }
})
