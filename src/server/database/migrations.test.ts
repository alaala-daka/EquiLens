import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase } from "./connection"
import { businessMigrations, migrateBusiness } from "./migrations"

test("DB-01: business migrations repeat safely without changing anonymous schema", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    const before = await db.transaction(c => c.query("SELECT version FROM equilens_schema"))
    await migrateBusiness(db)
    await migrateBusiness(db)
    assert.deepEqual(await db.transaction(c => c.query("SELECT version FROM equilens_schema")), before)
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_business_migrations"))).rows.length, 1)
    await assert.rejects(migrateBusiness(db, [{ ...businessMigrations[0], statements: ["SELECT 1"] }]), /history mismatch/)
    await assert.rejects(migrateBusiness(db, []), /history mismatch/)
    await assert.rejects(migrateBusiness(db, [{ id: "0002", statements: ["SELECT 1"] }]), /sequence/)
  } finally { await db.close() }
})

test("DB-01: failed migration rolls back schema and ledger together", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(db)
    await assert.rejects(migrateBusiness(db, [...businessMigrations, { id: "0002", statements: [
      "CREATE TABLE synthetic_rollback (id INTEGER)", "INSERT INTO missing_synthetic_table(id) VALUES (1)",
    ] }]))
    assert.equal((await db.transaction(c => c.query("SELECT name FROM sqlite_master WHERE name='synthetic_rollback'"))).rows.length, 0)
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_business_migrations"))).rows.length, 1)
    await migrateBusiness(db)
  } finally { await db.close() }
})
