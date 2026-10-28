import assert from "node:assert/strict"
import test from "node:test"
import { safeReturnTarget } from "./return-target"
import { createLoginController } from "./login-controller"
import { createSessionController } from "./session-controller"
import { AuthClientError, createAuthClient } from "./client"
const session = { user: { id: "synthetic", username: "operator" }, expiresAt: "2026-10-28T00:00:00.000Z" }
test("return targets reject external, encoded and control attacks and preserve queries", () => {
  for (const input of [null, "https://evil.example", "//evil.example", "/\\evil.example", "%2f%2fevil.example", "/%2fhost", "/%255chost", "/%250ahost", "/\nhost", "/%00host", "/%zz"]) assert.equal(safeReturnTarget(input, "https://equilens.example"), "/")
  assert.equal(safeReturnTarget("/?document=one&name=%E4%B8%AD", "https://equilens.example"), "/?document=one&name=%E4%B8%AD")
})
test("login locks synchronously and permits explicit retry after rejection", async () => {
  let count = 0
  let reject!: (reason: Error) => void
  const controller = createLoginController({ submit: async () => { count++; return new Promise<typeof session>((_, fail) => { reject = fail }) }, onSuccess: () => assert.fail() })
  const first = controller.run("operator", "secret")
  await controller.run("operator", "secret")
  assert.equal(count, 1); assert.equal(controller.pending(), true)
  reject(new Error("failed")); await assert.rejects(first)
  assert.equal(controller.pending(), false)
  const retry = controller.run("operator", "secret"); assert.equal(count, 2)
  reject(new Error("failed")); await assert.rejects(retry)
})
test("cancelled leave and failed logout never clear or navigate", async () => {
  let calls = 0
  const base = { check: async () => session, logout: async () => { calls++; throw new Error("offline") }, clear: () => assert.fail(), navigate: () => assert.fail() }
  await createSessionController({ ...base, leave: async () => false }).exit(); assert.equal(calls, 0)
  await assert.rejects(createSessionController({ ...base, leave: async () => true }).exit()); assert.equal(calls, 1)
})
test("401 immediately clears, network errors preserve session; successful logout clears before navigating", async () => {
  const events: string[] = []
  const base = { leave: async () => true, logout: async () => {}, clear: () => { events.push("clear") }, navigate: (path: string) => { events.push(path) } }
  await createSessionController({ ...base, check: async () => { throw new AuthClientError(401, "会话已失效。") } }).refresh()
  assert.deepEqual(events, ["clear", "/login"]); events.length = 0
  await assert.rejects(createSessionController({ ...base, check: async () => { throw new Error("offline") } }).refresh()); assert.deepEqual(events, [])
  await createSessionController({ ...base, check: async () => session }).exit(); assert.deepEqual(events, ["clear", "/login"])
})
test("client uses same-origin cookies, no-store and safe errors without retry", async () => {
  let calls = 0
  const client = createAuthClient(async (_url, init) => { calls++; assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin"); return new Response(JSON.stringify({ error: { message: "secret internal detail" } }), { status: 429, headers: { "Retry-After": "60" } }) })
  await assert.rejects(client.login("operator", "secret"), (error: unknown) => error instanceof AuthClientError && error.retryAfter === 60 && !error.message.includes("secret"))
  assert.equal(calls, 1)
})
