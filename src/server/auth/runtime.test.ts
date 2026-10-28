import assert from "node:assert/strict"
import { test } from "node:test"
import { authConfig } from "./config"
import { createAuthRuntime } from "./runtime-core"
import type { AuthService } from "./service"
const service = {} as AuthService
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
test("AUTH-06: config rejects unsafe origins and uses fixed deployment source", () => {
  for (const origin of [undefined, "", "https://example.com/path", "https://user:pass@example.com", "https://example.com?x", "http://example.com", "http://localhost"]) {
    assert.throws(() => authConfig({ NODE_ENV: "production", APP_ORIGIN: origin }), { code: "AUTH_UNAVAILABLE" })
  }
  assert.deepEqual(authConfig({ NODE_ENV: "production", APP_ORIGIN: "https://example.com" }), { origin: "https://example.com", secure: true, cookieName: "__Host-equilens-auth", source: "deployment" })
  assert.equal(authConfig({ NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1:3000" }).cookieName, "equilens-auth-dev")
  assert.throws(() => authConfig({ NODE_ENV: "test", APP_ORIGIN: "http://localhost" }))
  assert.throws(() => authConfig({ NODE_ENV: "development", APP_ORIGIN: "http://remote.test" }))
})
test("AUTH-06: repeat start shares initialization; stop during startup cannot publish ready or timer", async () => {
  const gate = deferred(); let calls = 0; let timers = 0
  const runtime = createAuthRuntime({ initialize: async () => { calls++; await gate.promise; return service }, sweep: async () => {}, schedule: () => { timers++; return () => {} } })
  assert.throws(() => runtime.get(), { code: "AUTH_UNAVAILABLE" })
  runtime.start(); runtime.start(); await flush(); assert.equal(calls, 1)
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true })
  runtime.start(); await flush(); assert.equal(stopped, false)
  gate.resolve(); await stopping; assert.equal(timers, 0); assert.throws(() => runtime.get())
  runtime.start(); await flush(); assert.equal(runtime.get(), service); await runtime.stop()
})
test("AUTH-06: failed init retries only on explicit start; cleanup is nonoverlapping and stop waits", async () => {
  let attempts = 0; let tick!: () => void; let cancelled = 0; let sweeps = 0; const gate = deferred()
  const runtime = createAuthRuntime({ initialize: async () => { if (++attempts === 1) throw Error("private"); return service }, sweep: async () => { sweeps++; await gate.promise }, schedule: (callback, interval) => { assert.equal(interval, 3600000); tick = callback; return () => { cancelled++ } } })
  runtime.start(); await flush(); assert.throws(() => runtime.get()); assert.equal(attempts, 1)
  runtime.start(); await flush(); assert.equal(runtime.get(), service); assert.equal(sweeps, 1)
  tick(); tick(); assert.equal(sweeps, 1)
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true }); await flush(); assert.equal(stopped, false); assert.equal(cancelled, 1)
  gate.resolve(); await stopping; tick(); assert.equal(sweeps, 1)
})

test("AUTH-06: cleanup failure preserves readiness and next scheduled tick retries", async () => {
  let tick!: () => void; let calls = 0
  const runtime = createAuthRuntime({ initialize: async () => service, sweep: async () => { if (++calls === 1) throw Error("synthetic") }, schedule: callback => { tick = callback; return () => {} } })
  runtime.start(); await flush(); assert.equal(runtime.get(), service)
  tick(); await flush(); assert.equal(calls, 2); assert.equal(runtime.get(), service); await runtime.stop()
})

test("AUTH-06: server entry import and build instrumentation do not initialize auth", async () => {
  const { execFileSync } = await import("node:child_process")
  const script = `
    import assert from 'node:assert/strict';
    const { authServices, stopAuthRuntime } = await import('./src/server/auth/runtime.ts');
    assert.throws(authServices, { code: 'AUTH_UNAVAILABLE' });
    const { register } = await import('./src/instrumentation.ts');
    await register();
    assert.throws(authServices, { code: 'AUTH_UNAVAILABLE' });
    await stopAuthRuntime();
  `
  execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", script], { env: { ...process.env, NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build", DATABASE_PROVIDER: "invalid", APP_ORIGIN: "https://synthetic.test" }, stdio: "pipe" })
})

test("AUTH-06: failed startup leaves public health available without readiness", async () => {
  const { execFileSync } = await import("node:child_process")
  const script = `
    import assert from 'node:assert/strict';
    const auth = await import('./src/server/auth/runtime.ts');
    auth.startAuthRuntime();
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(auth.authServices, { code: 'AUTH_UNAVAILABLE' });
    const { GET } = await import('./src/app/healthz/route.ts');
    assert.equal(GET().status, 200);
    await auth.stopAuthRuntime();
  `
  const result = execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", script], { env: { ...process.env, APP_ORIGIN: "", DATABASE_PROVIDER: "invalid" }, stdio: "pipe" })
  assert.equal(result.toString(), "")
})

test("AUTH-06: scheduler failure leaves startup retryable without a leaked timer", async () => {
  let schedules = 0, active = 0, cancelled = 0
  const runtime = createAuthRuntime({ initialize: async () => service, sweep: async () => {}, schedule: () => {
    if (++schedules === 1) throw Error("synthetic scheduler failure")
    active++
    return () => { active--; cancelled++ }
  } })
  runtime.start(); await flush()
  assert.throws(() => runtime.get(), { code: "AUTH_UNAVAILABLE" }); assert.equal(active, 0)
  runtime.start(); await flush()
  assert.equal(schedules, 2); assert.equal(runtime.get(), service); assert.equal(active, 1)
  await runtime.stop(); assert.equal(active, 0); assert.equal(cancelled, 1)
})

test("AUTH-07: separately loaded server entry reuses the process lifecycle without initialization", async () => {
  const { execFileSync } = await import("node:child_process")
  const script = `
    import assert from 'node:assert/strict';
    const identity = {};
    let starts = 0;
    globalThis.equilensAuthRuntime = { start() { starts++ }, stop: async () => {}, get: () => identity };
    const first = await import('./src/server/auth/runtime.ts?bundle=instrumentation');
    const second = await import('./src/server/auth/runtime.ts?bundle=route');
    assert.equal(starts, 0);
    first.startAuthRuntime();
    assert.equal(starts, 1);
    assert.equal(first.authServices(), identity);
    assert.equal(second.authServices(), identity);
    await second.stopAuthRuntime();
  `
  execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", script], { env: { ...process.env, DATABASE_PROVIDER: "invalid", APP_ORIGIN: "" }, stdio: "pipe" })
})
