import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { AuthService } from "./service"
import { bootstrapAdmin as runBootstrapAdmin } from "./bootstrap"

const password = "Synthetic password 123!"
test("ADMIN-01/02: explicit bootstrap is one-time and stores only a password hash", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(db)
    const auth = new AuthService(db)
    await bootstrapAdmin(auth, { BOOTSTRAP_ADMIN_USERNAME: "synthetic-admin", BOOTSTRAP_ADMIN_PASSWORD: password })
    const login = await auth.login("synthetic-admin", password, "deployment")
    assert.equal(login.user.role, "superadmin")
    assert.equal((await auth.session(login.token))?.account.role, "superadmin")
    const rows = (await db.transaction(c => c.query("SELECT password_hash FROM equilens_auth_accounts"))).rows
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].password_hash, password)
    await auth.maintain({ action: "revoke-admin", username: "synthetic-admin", actor: "synthetic-operator" })
    await bootstrapAdmin(auth, { BOOTSTRAP_ADMIN_USERNAME: "another-admin", BOOTSTRAP_ADMIN_PASSWORD: password + "changed" })
    assert.equal((await auth.login("synthetic-admin", password, "deployment")).user.role, "member")
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_auth_accounts"))).rows.length, 1)
  } finally { await db.close() }
})

import { businessMigrations } from "../database/migrations"
import { createAccountAccess } from "./handlers"
import { authConfig } from "./config"
import { createAuthRuntime } from "./runtime-core"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function setup() {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(db)
  return { db, auth: new AuthService(db) }
}
const env = { BOOTSTRAP_ADMIN_USERNAME: "synthetic-admin", BOOTSTRAP_ADMIN_PASSWORD: password }

test("ADMIN-01: upgrading legacy accounts retains member default and immutable migration history", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(db, businessMigrations.slice(0, 2))
    await db.transaction(c => c.query("INSERT INTO equilens_auth_accounts VALUES ('legacy','legacy','unused',1,1)"))
    const before = (await db.transaction(c => c.query("SELECT * FROM equilens_business_migrations"))).rows
    await migrateBusiness(db)
    assert.equal((await db.transaction(c => c.query("SELECT role FROM equilens_auth_accounts"))).rows[0].role, "member")
    const after = (await db.transaction(c => c.query("SELECT * FROM equilens_business_migrations"))).rows
    assert.deepEqual(after.filter(row => before.some(previous => previous.id === row.id)), before)
  } finally { await db.close() }
})

test("ADMIN-02: missing, invalid and collision configurations leave no bootstrap state", async () => {
  const { db, auth } = await setup()
  try {
    await bootstrapAdmin(auth, {})
    for (const config of [{ BOOTSTRAP_ADMIN_USERNAME: "synthetic-admin" }, { BOOTSTRAP_ADMIN_PASSWORD: password }, { ...env, BOOTSTRAP_ADMIN_USERNAME: "" }, { ...env, BOOTSTRAP_ADMIN_USERNAME: "!" }, { ...env, BOOTSTRAP_ADMIN_PASSWORD: "short" }]) await assert.rejects(bootstrapAdmin(auth, config), { code: "INVALID_INPUT" })
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_auth_accounts"))).rows.length, 0)
    await auth.maintain({ action: "create", username: "synthetic-admin", password, actor: "operator" })
    await assert.rejects(bootstrapAdmin(auth, env), { code: "ACCOUNT_CONFLICT" })
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_auth_bootstrap"))).rows.length, 0)
    assert.equal((await db.transaction(c => c.query("SELECT action FROM equilens_auth_audit"))).rows.length, 1)
    assert.equal((await auth.login("synthetic-admin", password, "deployment")).user.role, "member")
  } finally { await db.close() }
})

test("ADMIN-02: concurrent initialization creates one account and late audit failure rolls back everything", async () => {
  const { db, auth } = await setup()
  try {
    const broken = new AuthService({ close: () => db.close(), transaction: work => db.transaction(c => work({ query: (sql, values) => { if (sql.includes("INSERT INTO equilens_auth_audit")) throw Error("synthetic late failure"); return c.query(sql, values) } })) })
    await assert.rejects(bootstrapAdmin(broken, env), /synthetic late failure/)
    for (const table of ["equilens_auth_accounts", "equilens_auth_bootstrap", "equilens_auth_audit"]) assert.equal((await db.transaction(c => c.query(`SELECT * FROM ${table}`))).rows.length, 0)
    await Promise.all([bootstrapAdmin(auth, env), bootstrapAdmin(new AuthService(db), { ...env, BOOTSTRAP_ADMIN_USERNAME: "another-admin" })])
    for (const table of ["equilens_auth_accounts", "equilens_auth_bootstrap", "equilens_auth_audit"]) assert.equal((await db.transaction(c => c.query(`SELECT * FROM ${table}`))).rows.length, 1)
  } finally { await db.close() }
})

test("ADMIN-03/04: fresh guards reject untrusted role, live demotion, invalid roles and revoked sessions", async () => {
  const { db, auth } = await setup()
  let clock = Date.now()
  const timed = new AuthService(db, () => clock)
  const config = () => authConfig({ APP_ORIGIN: "https://synthetic.test" })
  const access = createAccountAccess({ services: () => timed, config })
  const request = (token = "") => new Request("https://synthetic.test", { headers: { Cookie: `__Host-equilens-auth=${token}; role=superadmin`, "X-Role": "superadmin" } })
  try {
    await assert.rejects(access.requireSuperAdmin(request()), { code: "UNAUTHENTICATED" })
    await assert.rejects(access.requireSuperAdmin(request("f".repeat(64))), { code: "UNAUTHENTICATED" })
    await auth.maintain({ action: "create", username: "operator", password, actor: "maintenance" })
    const member = await timed.login("operator", password, "deployment")
    await assert.rejects(access.requireSuperAdmin(request(member.token)), { code: "FORBIDDEN" })
    await auth.maintain({ action: "grant-admin", username: "operator", actor: "maintenance" })
    assert.equal(await timed.session(member.token), null)
    const first = await timed.login("operator", password, "deployment")
    const second = await timed.login("operator", password, "deployment")
    const identity = await access.requireSuperAdmin(request(first.token))
    assert.equal((await access.revalidateSuperAdminSession(identity.session.id)).account.role, "superadmin")
    await db.transaction(c => c.query("UPDATE equilens_auth_accounts SET role='member' WHERE username='operator'"))
    await assert.rejects(access.revalidateSuperAdminSession(identity.session.id), { code: "FORBIDDEN" })
    await db.transaction(c => c.query("UPDATE equilens_auth_accounts SET role='invalid' WHERE username='operator'"))
    await assert.rejects(access.requireSuperAdmin(request(first.token)), { code: "AUTH_UNAVAILABLE" })
    await assert.rejects(timed.login("operator", password, "another-source"), { code: "AUTH_UNAVAILABLE" })
    await auth.maintain({ action: "revoke-admin", username: "operator", actor: "maintenance" })
    assert.equal(await timed.session(first.token), null); assert.equal(await timed.session(second.token), null)
    await auth.maintain({ action: "grant-admin", username: "operator", actor: "maintenance" })
    await auth.maintain({ action: "reset", username: "operator", password: password + "new", actor: "maintenance" })
    const reset = await timed.login("operator", password + "new", "deployment")
    assert.equal(reset.user.role, "superadmin")
    await auth.maintain({ action: "disable", username: "operator", actor: "maintenance" })
    await assert.rejects(access.requireSuperAdmin(request(reset.token)), { code: "UNAUTHENTICATED" })
    await auth.maintain({ action: "enable", username: "operator", actor: "maintenance" })
    assert.equal(await timed.session(reset.token), null)
    clock += 15 * 60000
    const expiring = await timed.login("operator", password + "new", "deployment")
    clock += 12 * 3600000
    await assert.rejects(access.requireSuperAdmin(request(expiring.token)), { code: "UNAUTHENTICATED" })
    const logout = await timed.login("operator", password + "new", "deployment")
    await timed.logout(logout.token)
    await assert.rejects(access.requireSuperAdmin(request(logout.token)), { code: "UNAUTHENTICATED" })
    const unavailable = createAccountAccess({ config, services: () => { throw Error("private"); } })
    await assert.rejects(unavailable.requireSuperAdmin(request(first.token)), { code: "AUTH_UNAVAILABLE" })
    await assert.rejects(auth.maintain({ action: "grant-admin", username: "operator", actor: "maintenance", password }), { code: "INVALID_INPUT" })
  } finally { await db.close() }
})

test("ADMIN-02/04: reopen preserves marker, demotion, disabled state and password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-admin-"))
  const config = { provider: "sqlite", path: join(directory, "auth.sqlite") } as const
  let db = await connectDatabase(config)
  try {
    await migrateBusiness(db)
    const auth = new AuthService(db)
    await bootstrapAdmin(auth, env)
    await auth.maintain({ action: "revoke-admin", username: "synthetic-admin", actor: "operator" })
    await auth.maintain({ action: "disable", username: "synthetic-admin", actor: "operator" })
    const before = (await db.transaction(c => c.query("SELECT * FROM equilens_auth_accounts"))).rows
    await db.close(); db = await connectDatabase(config); await migrateBusiness(db)
    await bootstrapAdmin(new AuthService(db), { ...env, BOOTSTRAP_ADMIN_PASSWORD: password + "changed" })
    assert.deepEqual((await db.transaction(c => c.query("SELECT * FROM equilens_auth_accounts"))).rows, before)
    await assert.rejects(new AuthService(db).login("synthetic-admin", password, "deployment"), { code: "INVALID_CREDENTIALS" })
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_auth_bootstrap"))).rows.length, 1)
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("ADMIN-05: bootstrap config failure cannot publish runtime readiness", async () => {
  const { db, auth } = await setup()
  let scheduled = false
  const runtime = createAuthRuntime({ initialize: async () => { await bootstrapAdmin(auth, { BOOTSTRAP_ADMIN_USERNAME: "incomplete" }); return auth }, sweep: async () => {}, schedule: () => { scheduled = true; return () => {} } })
  try {
    runtime.start(); await new Promise(resolve => setImmediate(resolve))
    assert.throws(() => runtime.get(), { code: "AUTH_UNAVAILABLE" }); assert.equal(scheduled, false)
    assert.equal((await db.transaction(c => c.query("SELECT id FROM equilens_auth_accounts"))).rows.length, 0)
  } finally { await runtime.stop(); await db.close() }
})

function bootstrapAdmin(auth: AuthService, env: Record<string, string | undefined>) { return runBootstrapAdmin(auth, { NODE_ENV: "test", ...env }) }

test("ADMIN-04: audit failure rolls back role mutation and all-session deletion", async () => {
  const { db, auth } = await setup()
  try {
    await bootstrapAdmin(auth, env)
    const login = await auth.login("synthetic-admin", password, "deployment")
    const broken = new AuthService({ close: () => db.close(), transaction: work => db.transaction(c => work({ query: (sql, values) => { if (sql.includes("INSERT INTO equilens_auth_audit")) throw Error("synthetic audit failure"); return c.query(sql, values) } })) })
    await assert.rejects(broken.maintain({ action: "revoke-admin", username: "synthetic-admin", actor: "operator" }), /synthetic audit failure/)
    assert.equal((await auth.session(login.token))?.account.role, "superadmin")
    const audit = (await db.transaction(c => c.query("SELECT action,actor FROM equilens_auth_audit"))).rows
    assert.deepEqual(audit.map(row => ({ ...row })), [{ action: "bootstrap", actor: "deployment" }])
    await auth.maintain({ action: "revoke-admin", username: "synthetic-admin", actor: "operator" })
    const changed = (await db.transaction(c => c.query("SELECT action,actor,created_at FROM equilens_auth_audit WHERE action='revoke-admin'"))).rows
    assert.equal(changed[0].actor, "operator"); assert.ok(Number(changed[0].created_at) > 0)
  } finally { await db.close() }
})
