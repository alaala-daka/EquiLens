import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { cleanExpiredAuth } from "./cleanup"
async function fixture(count: number) {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" }); await migrateBusiness(db)
  await db.transaction(async c => {
    await c.query("INSERT INTO equilens_auth_accounts VALUES ('a','synthetic','unused',1,1)")
    await c.query("INSERT INTO equilens_auth_audit VALUES ('audit','a','create','synthetic',1)")
    for (let i = 0; i < count; i++) {
      await c.query("INSERT INTO equilens_auth_sessions VALUES ($1,'a',1000000)", [String(i).padStart(8, "0")])
      await c.query("INSERT INTO equilens_auth_limits VALUES ($1,100000,1)", [String(i).padStart(8, "0")])
    }
    await c.query("INSERT INTO equilens_auth_sessions VALUES ('valid','a',1000001)")
    await c.query("INSERT INTO equilens_auth_limits VALUES ('valid',100001,1)")
  }); return db
}
test("AUTH-06: cleanup uses fixed cutoff and bounded batches preserving valid rows, accounts and audit", async () => {
  const db = await fixture(1001)
  try {
    let clocks = 0
    assert.deepEqual(await cleanExpiredAuth(db, () => { clocks++; return 1000000 }), { sessions: 1000, limits: 1000, batches: 10 })
    assert.equal(clocks, 1)
    const second = await cleanExpiredAuth(db, () => 1000000); assert.equal(second.sessions, 1); assert.equal(second.limits, 1)
    for (const table of ["sessions", "limits", "accounts", "audit"]) assert.equal((await db.transaction(c => c.query(`SELECT * FROM equilens_auth_${table}`))).rows.length, 1)
  } finally { await db.close() }
})
test("AUTH-06: conditional deletion preserves a refreshed window and transaction failure rolls back", async () => {
  const db = await fixture(1)
  try {
    let refreshed = false
    const wrapped: Database = { close: () => db.close(), transaction: work => db.transaction(c => work({ query: async (sql, values) => {
      if (sql.startsWith("DELETE FROM equilens_auth_limits") && !refreshed) { refreshed = true; await c.query("UPDATE equilens_auth_limits SET window_start=1000001 WHERE limit_key=$1", [String(values![0])]) }
      return c.query(sql, values)
    } })) }
    assert.equal((await cleanExpiredAuth(wrapped, () => 1000000)).limits, 0)
    await db.transaction(async c => { await c.query("UPDATE equilens_auth_sessions SET expires_at=1000000 WHERE token_hash='valid'"); await c.query("UPDATE equilens_auth_limits SET window_start=100000") })
    const broken: Database = { close: () => db.close(), transaction: work => db.transaction(c => work({ query: async (sql, values) => { if (sql.startsWith("DELETE FROM equilens_auth_limits")) throw Error("synthetic"); return c.query(sql, values) } })) }
    await assert.rejects(cleanExpiredAuth(broken, () => 1000000))
    assert.equal((await db.transaction(c => c.query("SELECT * FROM equilens_auth_sessions WHERE token_hash='valid'"))).rows.length, 1)
  } finally { await db.close() }
})

