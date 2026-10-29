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
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_business_migrations"))).rows.length, businessMigrations.length)
    await assert.rejects(migrateBusiness(db, [{ ...businessMigrations[0], statements: ["SELECT 1"] }]), /history mismatch/)
    await assert.rejects(migrateBusiness(db, []), /history mismatch/)
    await assert.rejects(migrateBusiness(db, [{ id: "0002", statements: ["SELECT 1"] }]), /sequence/)
  } finally { await db.close() }
})

test("DB-01: failed migration rolls back schema and ledger together", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(db)
    await assert.rejects(migrateBusiness(db, [...businessMigrations, { id: String(businessMigrations.length + 1).padStart(4, "0"), statements: [
      "CREATE TABLE synthetic_rollback (id INTEGER)", "INSERT INTO missing_synthetic_table(id) VALUES (1)",
    ] }]))
    assert.equal((await db.transaction(c => c.query("SELECT name FROM sqlite_master WHERE name='synthetic_rollback'"))).rows.length, 0)
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_business_migrations"))).rows.length, businessMigrations.length)
    await migrateBusiness(db)
  } finally { await db.close() }
})


test("DB-01: original 0001 checksum and upgrade history remain immutable", async () => {
  const { createHash } = await import("node:crypto")
  assert.equal(createHash("sha256").update(JSON.stringify(businessMigrations[0])).digest("hex"), "b6d5889230e98eeacebe62e7ee5604d6e036b93c4e67b57bf10bdd05ce3bba8a")
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(db, businessMigrations.slice(0, 1))
    const before = (await db.transaction(c => c.query("SELECT * FROM equilens_business_migrations WHERE id='0001'"))).rows
    await migrateBusiness(db)
    assert.deepEqual((await db.transaction(c => c.query("SELECT * FROM equilens_business_migrations WHERE id='0001'"))).rows, before)
    const indexes = (await db.transaction(c => c.query("SELECT name FROM sqlite_master WHERE type='index'"))).rows.map(row => row.name)
    assert.ok(indexes.includes("equilens_auth_session_expiry")); assert.ok(indexes.includes("equilens_auth_limit_window"))
  } finally { await db.close() }
})

test("DB-01: frozen 0004-0010 checksums prevent silent migration drift", async () => {
  const { createHash } = await import("node:crypto")
  const expected: Record<string, string> = {
    "0004": "e5cd6fdbc6534c3586f1bd5ffecdc3f0306d76c78a231181e3c599e5175cc185",
    "0005": "9677479c49ed95563d2e3330a777b20371ea5bc87b07db4144b4f0d9715e541c",
    "0006": "e6422725f6e246dfd57c8d139c885088f9ad22ef61a97c8dc11f04b588a03edf",
    "0007": "e8ba3f8045d08bf2e195380882d060b50d887555870557d40686f0080d3dece9",
    "0008": "096250a9eab4a2c83dbb5fb71b9c2020e0333e352a8de050571bf3bbab319931",
    "0009": "4c089b83ade96dc63d45cb3a81bdbf24e80dd28a30aeabbe581dc2b989dffd59",
    "0010": "3ad73b6d9013d5d21183e30fca67742a8c5baefe4b6c1c0d591736e91b45aed8",
  }
  for (const [id, digest] of Object.entries(expected)) {
    const migration = businessMigrations.find(row => row.id === id)
    assert.ok(migration, `missing migration ${id}`)
    assert.equal(createHash("sha256").update(JSON.stringify(migration)).digest("hex"), digest, `migration ${id} changed; append a new migration instead`)
  }
})
