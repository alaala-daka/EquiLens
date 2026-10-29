import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { authConfig } from "./config"
import { createAccountAccess } from "./handlers"
import { AuthService } from "./service"

const config = () => authConfig({ APP_ORIGIN: "https://example.test" })
const request = (token?: string) => new Request("https://example.test/private", { headers: token ? { cookie: `__Host-equilens-auth=${token}` } : {} })

test("AUTH-05/AC-01: cookie identity and internal reference are rechecked before business access", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(db)
  let now = 1000
  const auth = new AuthService(db, () => now)
  const access = createAccountAccess({ services: () => auth, config })
  try {
    await auth.maintain({ action: "create", username: "operator", password: "Synthetic password 123!", actor: "synthetic-admin" })
    const login = await auth.login("operator", "Synthetic password 123!", "deployment")
    const incoming = request(login.token)
    const identity = await access.requireAccount(incoming)
    assert.deepEqual(identity.account, login.user)
    assert.equal(identity.session.expiresAt, login.expiresAt)
    assert.notEqual(identity.session.id, login.token)
    assert.deepEqual(await access.revalidateAccountSession(identity.session.id), identity)
    await assert.rejects(access.requireAccount(request(identity.session.id)), { code: "UNAUTHENTICATED" })
    await auth.logout(login.token)
    await assert.rejects(access.requireAccount(incoming), { code: "UNAUTHENTICATED" })
    let businessAccessed = false
    const consume = async () => {
      await access.revalidateAccountSession(identity.session.id)
      businessAccessed = true
    }
    await assert.rejects(consume(), { code: "UNAUTHENTICATED" })
    assert.equal(businessAccessed, false)
    const expiring = await auth.login("operator", "Synthetic password 123!", "deployment")
    const expiringIdentity = await access.requireAccount(request(expiring.token))
    now = expiring.expiresAt
    await assert.rejects(access.requireAccount(request(expiring.token)), { code: "UNAUTHENTICATED" })
    await assert.rejects(access.revalidateAccountSession(expiringIdentity.session.id), { code: "UNAUTHENTICATED" })
  } finally { await db.close() }
})

test("AUTH-05: absent, malformed and substituted browser identity never replace cookie", async () => {
  let calls = 0
  const access = createAccountAccess({ config, services: () => ({
    async session() { calls++; return null }, async revalidateSession() { return null },
  }) })
  for (const incoming of [request(), request("bad"), new Request("https://example.test/private?token=" + "a".repeat(64) + "&accountId=operator", { headers: { authorization: "Bearer " + "a".repeat(64), "x-account-id": "operator", "x-role": "admin" } })]) {
    await assert.rejects(access.requireAccount(incoming), { code: "UNAUTHENTICATED" })
  }
  assert.equal(calls, 0)
  await assert.rejects(access.revalidateAccountSession("bad"), { code: "UNAUTHENTICATED" })
})

test("AUTH-05: database, readiness and configuration failures stay unavailable", async () => {
  const broken = async () => { throw new Error("private database details") }
  const access = createAccountAccess({ config, services: () => ({ session: broken, revalidateSession: broken }) })
  await assert.rejects(access.requireAccount(request("a".repeat(64))), { code: "AUTH_UNAVAILABLE", message: "认证服务暂不可用。" })
  await assert.rejects(access.revalidateAccountSession("a".repeat(64)), { code: "AUTH_UNAVAILABLE" })
  const notReady = createAccountAccess({ config, services() { throw new Error("not ready") } })
  await assert.rejects(notReady.requireAccount(request("a".repeat(64))), { code: "AUTH_UNAVAILABLE" })
  const unconfigured = createAccountAccess({ config: () => authConfig({}), services: () => ({ session: broken, revalidateSession: broken }) })
  await assert.rejects(unconfigured.requireAccount(request()), { code: "AUTH_UNAVAILABLE" })
  await assert.rejects(unconfigured.revalidateAccountSession("a".repeat(64)), { code: "AUTH_UNAVAILABLE" })
})
