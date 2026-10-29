import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { createMaterialLifecycle } from "./lifecycle"

test("C2b lifecycle is inert before start, registers first, starts once, and never overlaps repair", async () => {
  const events: string[] = [], timers: (() => void)[] = []
  let finish!: () => void
  let active = 0, maximum = 0
  const lifecycle = createMaterialLifecycle({ register: () => events.push("register"), repair: async () => { events.push("repair"); active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => { finish = resolve }); active-- }, schedule: cb => timers.push(cb), report: () => events.push("failure") })
  assert.deepEqual(events, [])
  lifecycle.start(); lifecycle.start()
  assert.deepEqual(events, ["register", "repair"])
  assert.equal(timers.length, 0)
  finish(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.length, 1)
  timers.shift()!()
  lifecycle.start()
  assert.equal(maximum, 1)
  assert.equal(timers.length, 0)
  finish(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.length, 1)
})
test("C2b lifecycle reports repair failure and schedules bounded retry", async () => {
  let failures = 0, timers = 0
  createMaterialLifecycle({ register() {}, repair: async () => { throw Error("synthetic") }, report: () => { failures++ }, schedule: () => { timers++ } }).start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failures, 1); assert.equal(timers, 1)
})
test("C2b explicit instrumentation build guard precedes registration and runner", async () => {
  const source = await readFile("src/instrumentation.ts", "utf8")
  assert.ok(source.indexOf('phase-production-build') < source.indexOf('startMaterialRuntime()'))
  assert.ok(source.indexOf('startMaterialRuntime()') < source.indexOf('startTaskRunner()'))
  const runtime = await readFile("src/server/materials/runtime.ts", "utf8")
  assert.ok(runtime.indexOf('authorizeTaskExecution({') < runtime.indexOf('.submit(intent.accountId'))
  assert.ok(runtime.includes('`material:${version.id}`'))
})

test("C2b recovery rechecks authorization and never submits after revocation", async () => {
  const { recoverAuthorizedMaterial } = await import("./lifecycle")
  let permitted = true, checks = 0, submissions = 0
  const authorize = async () => { checks++; if (!permitted) throw Error("revoked") }
  const submit = async () => { submissions++; return "same-version-idempotency-key" }
  assert.equal(await recoverAuthorizedMaterial(authorize, submit), "same-version-idempotency-key")
  permitted = false
  await assert.rejects(recoverAuthorizedMaterial(authorize, submit), /revoked/)
  assert.equal(checks, 2); assert.equal(submissions, 1)
})
