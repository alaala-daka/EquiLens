import assert from "node:assert/strict"
import test from "node:test"
import { createAuthHandlers } from "./handlers"
import { authConfig } from "./config"
import { AuthError } from "./errors"
import type { AuthService } from "./service"
const origin = "https://equilens.example"
const token = "a".repeat(64)
function setup() {
  const calls: unknown[][] = []
  let failure: unknown
  const service = {
    async login(...args: unknown[]) { calls.push(args); if (failure) throw failure; return { token, user: { id: "1", username: "demo", role: "member" as const }, expiresAt: 120999 } },
    async session(...args: unknown[]) { calls.push(args); if (failure) throw failure; return args[0] === token ? { account: { id: "1", username: "demo", role: "member" as const }, session: { id: "secret", expiresAt: 120999 } } : null },
    async logout(...args: unknown[]) { calls.push(args); if (failure) throw failure },
  }
  const handlers = createAuthHandlers({ services: () => service as unknown as AuthService, config: () => authConfig({ APP_ORIGIN: origin, NODE_ENV: "production" }), now: () => 999 })
  return { handlers, calls, fail: (value: unknown) => { failure = value } }
}
function login(body = '{"username":"demo","password":"unchanged"}', headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body })
}
async function check(response: Response, status: number, code?: string) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  if (code) assert.equal((await response.json()).error.code, code)
}
test("AUTH-01/02 rejects origin, type and structure before services", async () => {
  const { handlers, calls } = setup()
  for (const value of ["", "null", "https://evil.example"]) await check(await handlers.login(login("{}", { Origin: value })), 403, "INVALID_ORIGIN")
  await check(await handlers.login(login("{}", { "Content-Type": "text/plain" })), 415, "UNSUPPORTED_MEDIA_TYPE")
  for (const body of ["{", "null", "[]", '{"username":"a","password":"b","token":"injected"}', '{"username":2,"password":"b"}']) await check(await handlers.login(login(body)), 400, "INVALID_INPUT")
  assert.equal(calls.length, 0)
})
test("AUTH-02 bounds streamed bytes and cancels oversized input", async () => {
  const { handlers, calls } = setup(); let cancelled = false
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(2049)) }, cancel() { cancelled = true } })
  const request = new Request(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit)
  await check(await handlers.login(request), 413, "PAYLOAD_TOO_LARGE")
  assert.equal(cancelled, true); assert.equal(calls.length, 0)
})
test("AUTH-02/03 cookie, fixed source and safe session view", async () => {
  const { handlers, calls } = setup()
  const response = await handlers.login(login(undefined, { Cookie: `__Host-equilens-auth=${token}; equilens-auth-dev=other`, "X-Forwarded-For": "evil", Forwarded: "evil" }))
  await check(response, 200)
  assert.deepEqual(calls[0], ["demo", "unchanged", "deployment", token])
  assert.deepEqual(await response.json(), { user: { id: "1", username: "demo", role: "member" as const }, expiresAt: new Date(120999).toISOString() })
  const cookie = response.headers.get("set-cookie")!
  for (const part of ["__Host-equilens-auth=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=120"]) assert.ok(cookie.includes(part))
  assert.ok(!cookie.includes("Domain"))
  const session = await handlers.session(new Request(`${origin}/api/auth/session`, { headers: { Cookie: `__Host-equilens-auth=${token}` } }))
  await check(session, 200); assert.equal(session.headers.get("set-cookie"), null)
})
test("AUTH-03 rejects duplicate cookies and identity query injection", async () => {
  const { handlers } = setup()
  await check(await handlers.session(new Request(`${origin}/api/auth/session`, { headers: { Cookie: `__Host-equilens-auth=${token}; __Host-equilens-auth=${token}` } })), 401, "UNAUTHENTICATED")
  await check(await handlers.session(new Request(`${origin}/api/auth/session?token=${token}`)), 400, "INVALID_INPUT")
})
test("AUTH-04 safe errors, retry seconds, and logout failure preserves cookie", async () => {
  const { handlers, fail } = setup()
  fail(new AuthError("LOGIN_RATE_LIMITED", "secret", 37))
  const limited = await handlers.login(login()); await check(limited, 429, "LOGIN_RATE_LIMITED"); assert.equal(limited.headers.get("retry-after"), "37")
  fail(new Error("private database/password detail"))
  const failed = await handlers.logout(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { Origin: origin, Cookie: `__Host-equilens-auth=${token}` } }))
  await check(failed, 503, "AUTH_UNAVAILABLE"); assert.equal(failed.headers.get("set-cookie"), null)
  fail(undefined)
  await check(await handlers.logout(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { Origin: origin }, body: "{}" })), 400, "INVALID_INPUT")
  const out = await handlers.logout(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { Origin: origin } }))
  await check(out, 204); assert.ok(out.headers.get("set-cookie")!.includes("Max-Age=0"))
})
test("AUTH-01 config fails closed and dev cookie is isolated", async () => {
  for (const env of [{}, { APP_ORIGIN: "http://localhost:3000", NODE_ENV: "production" }, { APP_ORIGIN: "https://example.com/path" }]) assert.throws(() => authConfig(env))
  assert.equal(authConfig({ APP_ORIGIN: "http://localhost:3000", NODE_ENV: "development" }).cookieName, "equilens-auth-dev")
  const handlers = createAuthHandlers({ services: () => { throw new Error("must not enter") }, config: () => authConfig({}), now: Date.now })
  await check(await handlers.login(login()), 503, "AUTH_UNAVAILABLE")
  await check(await handlers.session(new Request(`${origin}/api/auth/session`)), 503, "AUTH_UNAVAILABLE")
})
test("AUTH-02 every public error uses fixed safe messages and never issues token", async () => {
  const { handlers, fail } = setup()
  for (const [code, status] of [["INVALID_INPUT", 400], ["INVALID_CREDENTIALS", 401], ["AUTH_BUSY", 503], ["AUTH_UNAVAILABLE", 503], ["ACCOUNT_CONFLICT", 503], ["ACCOUNT_NOT_FOUND", 503]] as const) {
    fail(new AuthError(code, "secret/password/database"))
    const result = await handlers.login(login())
    assert.equal(result.status, status); assert.equal(result.headers.get("cache-control"), "private, no-store")
    assert.equal(result.headers.get("set-cookie"), null); assert.ok(!(await result.text()).includes("secret"))
  }
})
test("AUTH-01 ready failure applies even without session cookie", async () => {
  const handlers = createAuthHandlers({ config: () => authConfig({ APP_ORIGIN: origin }), services: () => { throw new Error("not ready") }, now: Date.now })
  const result = await handlers.session(new Request(`${origin}/api/auth/session`))
  await check(result, 503, "AUTH_UNAVAILABLE"); assert.equal(result.headers.get("set-cookie"), null)
})
test("AUTH-03 production ignores development cookie; HTTP development writes separate cookie", async () => {
  const production = setup()
  const ignored = await production.handlers.session(new Request(`${origin}/api/auth/session`, { headers: { Cookie: `equilens-auth-dev=${token}` } }))
  await check(ignored, 401, "UNAUTHENTICATED"); assert.equal(production.calls.length, 0)
  const handlers = createAuthHandlers({ config: () => authConfig({ APP_ORIGIN: "http://localhost:3000", NODE_ENV: "development" }), services: () => ({ login: async () => ({ token, user: { id: "1", username: "demo", role: "member" as const }, expiresAt: 120999 }), session: async () => null, logout: async () => {} }), now: () => 999 })
  const result = await handlers.login(login(undefined, { Origin: "http://localhost:3000" }))
  await check(result, 200)
  const value = result.headers.get("set-cookie")!
  assert.ok(value.startsWith("equilens-auth-dev=")); assert.ok(!value.includes("Secure"))
})
