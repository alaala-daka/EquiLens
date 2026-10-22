import assert from "node:assert/strict"
import { test } from "node:test"
import { databaseConfig } from "./config"

test("DB-04/07: provider is explicit, GaussDB requires configuration and verifies TLS", () => {
  assert.equal(databaseConfig({}).provider, "sqlite")
  assert.throws(() => databaseConfig({ DATABASE_PROVIDER: "postgres" }), /DATABASE_PROVIDER/)
  assert.throws(() => databaseConfig({ DATABASE_PROVIDER: "gaussdb" }), /GAUSSDB_HOST/)
  const config = databaseConfig({ DATABASE_PROVIDER: "gaussdb", GAUSSDB_HOST: "database.invalid", GAUSSDB_DATABASE: "test", GAUSSDB_USER: "test", GAUSSDB_PASSWORD: "synthetic" })
  assert.equal(config.provider, "gaussdb")
  if (config.provider !== "gaussdb") throw new Error("provider mismatch")
  assert.equal(config.connection.ssl.rejectUnauthorized, true)
  assert.equal(config.connection.port, 8000)
  assert.equal(config.connection.max, 4)
})
