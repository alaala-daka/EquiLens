import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { AuthService } from "./service"
import { assertAuthOrigin } from "./http"

const password = "Synthetic password 123!"
async function setup() {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(db)
  let clock = Date.parse("2026-10-24T00:00:00Z")
  const auth = new AuthService(db, () => clock)
  return { db, auth, advance: (ms: number) => { clock += ms } }
}

test("AC-01: normalized controlled account, duplicate rejection and safe principal", async () => {
  const { db, auth } = await setup()
  try {
    await auth.maintain({ action: "create", username: " Operator ", password, actor: "synthetic-admin" })
    await assert.rejects(auth.maintain({ action: "create", username: "operator", password, actor: "synthetic-admin" }), { code: "ACCOUNT_CONFLICT" })
    const session = await auth.login("OPERATOR", password, "source-one")
    assert.match(session.token, /^[a-f0-9]{64}$/)
    assert.deepEqual(await auth.current(session.token), { id: session.user.id, username: "operator" })
    const stored = await db.transaction(c => c.query("SELECT token_hash FROM equilens_auth_sessions"))
    assert.notEqual(stored.rows[0].token_hash, session.token)
    await auth.logout(session.token)
    assert.equal(await auth.current(session.token), null)
  } finally { await db.close() }
})

test("AC-01: reset/disable revoke every session; enabling does not restore tokens", async () => {
  const { db, auth } = await setup()
  try {
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    const first = await auth.login("operator", password, "source")
    await auth.maintain({ action: "reset", username: "operator", password: password + "new", actor: "admin" })
    assert.equal(await auth.current(first.token), null)
    await assert.rejects(auth.login("operator", password, "source"), { code: "INVALID_CREDENTIALS" })
    const second = await auth.login("operator", password + "new", "source")
    await auth.maintain({ action: "disable", username: "operator", actor: "admin" })
    await assert.rejects(auth.login("operator", password + "new", "source"), { code: "INVALID_CREDENTIALS" })
    await auth.maintain({ action: "enable", username: "operator", actor: "admin" })
    assert.equal(await auth.current(second.token), null)
  } finally { await db.close() }
})

test("AC-01: fixed session expiry and unknown account has the same credential error", async () => {
  const { db, auth, advance } = await setup()
  try {
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    const session = await auth.login("operator", password, "source")
    advance(12 * 3600000 - 1)
    assert.ok(await auth.current(session.token))
    advance(1)
    assert.equal(await auth.current(session.token), null)
    await assert.rejects(auth.login("unknown", password, "source"), { code: "INVALID_CREDENTIALS" })
    await assert.rejects(auth.login("operator", "incorrect", "source"), { code: "INVALID_CREDENTIALS" })
  } finally { await db.close() }
})

test("AC-01/23: concurrent attempts and a new service cannot bypass persistent account quota", async () => {
  const { db, auth, advance } = await setup()
  try {
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => auth.login("unknown", password, "source")))
    const errors = results.map(r => r.status === "rejected" ? r.reason.code : "success")
    assert.equal(errors.filter(c => c === "INVALID_CREDENTIALS").length, 5)
    assert.equal(errors.filter(c => c === "LOGIN_RATE_LIMITED").length, 2)
    await assert.rejects(new AuthService(db, () => Date.parse("2026-10-24T00:00:00Z")).login("unknown", password, "source"), { code: "LOGIN_RATE_LIMITED" })
    advance(15 * 60000)
    await assert.rejects(auth.login("unknown", password, "source"), { code: "INVALID_CREDENTIALS" })
  } finally { await db.close() }
})

test("AC-01/12: sessions and attempt counts survive closing and reopening SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-auth-"))
  const config = { provider: "sqlite", path: join(directory, "auth.sqlite") } as const
  let db = await connectDatabase(config)
  const now = () => Date.parse("2026-10-24T00:00:00Z")
  try {
    await migrateBusiness(db)
    const auth = new AuthService(db, now)
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    const session = await auth.login("operator", password, "source")
    for (let n = 0; n < 29; n++) await assert.rejects(auth.login("!", password, "source"), { code: "INVALID_CREDENTIALS" })
    await db.close()
    db = await connectDatabase(config)
    await migrateBusiness(db)
    const reopened = new AuthService(db, now)
    assert.deepEqual(await reopened.current(session.token), session.user)
    const count = (await db.transaction(c => c.query("SELECT attempts FROM equilens_auth_limits"))).rows
    assert.deepEqual(count.map(r => Number(r.attempts)).sort((a, b) => a - b), [1, 30])
    await assert.rejects(reopened.login("!", password, "source"), { code: "LOGIN_RATE_LIMITED", retryAfterSeconds: 900 })
    const audit = (await db.transaction(c => c.query("SELECT action,actor FROM equilens_auth_audit"))).rows
    assert.deepEqual(audit.map(row => ({ ...row })), [{ action: "create", actor: "admin" }])
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("AC-01: source quota applies across accounts without expensive work after exhaustion", async () => {
  const { db, auth } = await setup()
  try {
    // A persisted exhausted source window represents 30 previous login attempts.
    const { createHash } = await import("node:crypto")
    await db.transaction(c => c.query("INSERT INTO equilens_auth_limits(limit_key,window_start,attempts) VALUES ($1,$2,30)", [createHash("sha256").update("source:source").digest("hex"), Date.parse("2026-10-24T00:00:00Z")]))
    await assert.rejects(auth.login("account-one", password, "source"), { code: "LOGIN_RATE_LIMITED" })
    await assert.rejects(auth.login("account-two", password, "source"), { code: "LOGIN_RATE_LIMITED" })
    await assert.rejects(auth.login("account-three", password, ""), { code: "INVALID_INPUT" })
  } finally { await db.close() }
})

test("AC-01: credential changes during verification cannot mint a session", async () => {
  const { db, auth } = await setup()
  try {
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    let credentialsRead = false
    const competing = new AuthService({ close: () => db.close(), transaction: work => db.transaction(async c => {
      return work({ async query(sql, values) {
        if (credentialsRead && sql.startsWith("UPDATE equilens_auth_accounts SET revision=revision")) await c.query("UPDATE equilens_auth_accounts SET enabled=0,revision=revision+1 WHERE username='operator'")
        const result = await c.query(sql, values)
        if (sql.includes("SELECT id,username,password_hash")) credentialsRead = true
        return result
      } })
    }) })
    await assert.rejects(competing.login("operator", password, "source"), { code: "INVALID_CREDENTIALS" })
    assert.equal((await db.transaction(c => c.query("SELECT token_hash FROM equilens_auth_sessions"))).rows.length, 0)
  } finally { await db.close() }
})

test("AC-01: strict configured write origin rejects cross-site, missing or credential URLs", () => {
  assert.doesNotThrow(() => assertAuthOrigin("https://equilens.example", "https://equilens.example"))
  for (const origin of [null, "null", "https://evil.example", "https://user@equilens.example", "https://equilens.example/path"]) {
    assert.throws(() => assertAuthOrigin(origin, "https://equilens.example"), { code: "INVALID_ORIGIN" })
  }
  assert.throws(() => assertAuthOrigin("https://equilens.example", undefined), { code: "INVALID_ORIGIN" })
})

test("AUTH-04: invalid accounts and account rejection retain source reservations", async () => {
  const { db, auth, advance } = await setup()
  try {
    for (let n = 0; n < 30; n++) await assert.rejects(auth.login("!", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    await assert.rejects(auth.login("operator", password, "deployment"), { code: "LOGIN_RATE_LIMITED", retryAfterSeconds: 900 })
    advance(15 * 60000)
    for (let n = 0; n < 30; n++) await assert.rejects(auth.login("unknown", password, "deployment"), { code: n < 5 ? "INVALID_CREDENTIALS" : "LOGIN_RATE_LIMITED" })
    await assert.rejects(auth.login("another", password, "deployment"), { code: "LOGIN_RATE_LIMITED" })
  } finally { await db.close() }
})

test("AUTH-04: over-bound strings reserve source before safe input rejection", async () => {
  const { db, auth } = await setup()
  try {
    for (let n = 0; n < 30; n++) await assert.rejects(auth.login("operator", "x".repeat(129), "deployment"), { code: "INVALID_INPUT" })
    await assert.rejects(auth.login("operator", password, "deployment"), { code: "LOGIN_RATE_LIMITED" })
  } finally { await db.close() }
})

test("AUTH-02/05: rotation revokes only previous session and references never revive", async () => {
  const { db, auth, advance } = await setup()
  try {
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    const first = await auth.login("operator", password, "device-one")
    const identity = await auth.session(first.token)
    assert.ok(identity)
    assert.deepEqual(identity.account, first.user)
    assert.equal(identity.session.expiresAt, first.expiresAt)
    assert.deepEqual(await auth.revalidateSession(identity.session.id), identity)
    const other = await auth.login("operator", password, "device-two")
    await assert.rejects(auth.login("operator", "wrong", "device-one", first.token), { code: "INVALID_CREDENTIALS" })
    assert.ok(await auth.current(first.token))
    const next = await auth.login("operator", password, "device-one", first.token)
    assert.equal(await auth.current(first.token), null)
    assert.equal(await auth.revalidateSession(identity.session.id), null)
    assert.ok(await auth.current(other.token))
    assert.ok(await auth.current(next.token))
    advance(12 * 3600000)
    assert.equal(await auth.session(next.token), null)
    await auth.maintain({ action: "disable", username: "operator", actor: "admin" })
    await auth.maintain({ action: "enable", username: "operator", actor: "admin" })
    assert.equal(await auth.revalidateSession(identity.session.id), null)
  } finally { await db.close() }
})

test("AUTH-04: unique-insert contention retries whole transactions once and preserves database failures", async () => {
  const { db, auth } = await setup()
  try {
    const { createHash } = await import("node:crypto")
    const key = createHash("sha256").update("source:deployment").digest("hex")
    await db.transaction(c => c.query("INSERT INTO equilens_auth_limits(limit_key,window_start,attempts) VALUES ($1,$2,1)", [key, Date.parse("2026-10-24T00:00:00Z")]))
    let hide = true
    let transactions = 0
    const competing = new AuthService({ close: async () => {}, transaction: work => {
      transactions++
      return db.transaction(c => work({ async query(sql, values) {
        if (hide && sql.startsWith("SELECT window_start")) { hide = false; return { rows: [], changes: 0 } }
        return c.query(sql, values)
      } }))
    } }, () => Date.parse("2026-10-24T00:00:00Z"))
    await assert.rejects(competing.login("!", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    assert.equal(transactions, 2)
    assert.equal((await db.transaction(c => c.query("SELECT attempts FROM equilens_auth_limits WHERE limit_key=$1", [key]))).rows[0].attempts, 2)
    for (const code of ["23505", "OTHER_DATABASE_FAILURE"]) {
      let tries = 0
      const failure = Object.assign(new Error("synthetic database failure"), { code })
      const unavailable = new AuthService({ close: async () => {}, transaction: async work => {
        tries++
        return work({ async query(sql) {
          if (sql.startsWith("SELECT")) return { rows: [], changes: 0 }
          throw failure
        } })
      } })
      await assert.rejects(unavailable.login("!", password, "deployment"), code === "23505" ? { code: "AUTH_UNAVAILABLE" } : error => error === failure)
      assert.equal(tries, code === "23505" ? 2 : 1)
    }
    // A real service remains usable after the rolled-back duplicate insert.
    await assert.rejects(auth.login("!", password, "fresh"), { code: "INVALID_CREDENTIALS" })
  } finally { await db.close() }
})

test("AUTH-04: window replacement contention rereads and retry-after rounds up", async () => {
  const { db, auth, advance } = await setup()
  try {
    await assert.rejects(auth.login("!", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    advance(15 * 60000)
    let conflict = true
    const competing = new AuthService({ close: async () => {}, transaction: work => db.transaction(c => work({ async query(sql, values) {
      if (conflict && sql.startsWith("UPDATE equilens_auth_limits SET window_start")) {
        conflict = false
        await c.query(sql, values)
        return { rows: [], changes: 0 }
      }
      return c.query(sql, values)
    } })) }, () => Date.parse("2026-10-24T00:15:00Z"))
    await assert.rejects(competing.login("!", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    for (let n = 0; n < 28; n++) await assert.rejects(auth.login("!", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    advance(1001)
    await assert.rejects(auth.login("!", password, "deployment"), { code: "LOGIN_RATE_LIMITED", retryAfterSeconds: 899 })
  } finally { await db.close() }
})

test("AUTH-02/03: failed rotation leaves old session and reset during verification blocks issuance", async () => {
  const { db, auth } = await setup()
  try {
    await auth.maintain({ action: "create", username: "operator", password, actor: "admin" })
    const first = await auth.login("operator", password, "source")
    const identity = await auth.session(first.token)
    assert.ok(identity)
    const failure = new Error("synthetic session failure")
    const failing = new AuthService({ close: async () => {}, transaction: work => db.transaction(c => work({ async query(sql, values) {
      if (sql.startsWith("DELETE FROM equilens_auth_sessions WHERE token_hash")) throw failure
      return c.query(sql, values)
    } })) })
    await assert.rejects(failing.login("operator", password, "source", first.token), error => error === failure)
    assert.deepEqual(await auth.revalidateSession(identity.session.id), identity)
    assert.equal((await db.transaction(c => c.query("SELECT token_hash FROM equilens_auth_sessions"))).rows.length, 1)
    let read = false
    const resetting = new AuthService({ close: async () => {}, transaction: work => db.transaction(c => work({ async query(sql, values) {
      if (read && sql.startsWith("UPDATE equilens_auth_accounts SET revision=revision")) {
        await c.query("UPDATE equilens_auth_accounts SET revision=revision+1 WHERE username='operator'")
        await c.query("DELETE FROM equilens_auth_sessions")
      }
      const result = await c.query(sql, values)
      if (sql.includes("SELECT id,username,password_hash")) read = true
      return result
    } })) })
    await assert.rejects(resetting.login("operator", password, "source", first.token), { code: "INVALID_CREDENTIALS" })
  } finally { await db.close() }
})

test("AUTH-04: simultaneous source reservations admit exactly thirty attempts", async () => {
  const { db, auth } = await setup()
  try {
    const results = await Promise.allSettled(Array.from({ length: 31 }, () => auth.login("!", password, "deployment")))
    const codes = results.map(result => result.status === "rejected" ? result.reason.code : "success")
    assert.equal(codes.filter(code => code === "INVALID_CREDENTIALS").length, 30)
    assert.equal(codes.filter(code => code === "LOGIN_RATE_LIMITED").length, 1)
  } finally { await db.close() }
})
