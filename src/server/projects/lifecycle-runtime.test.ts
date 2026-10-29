import assert from "node:assert/strict"
import { test } from "node:test"
import { createProjectLifecycleRuntime, projectDeletionJournalDirectory, projectLifecycleAvailable, projectLifecycleIntervalMs, requireProjectLifecycleReady } from "./lifecycle"

test("C7 runtime: start returns immediately, is not ready before initialize and fails closed for business entries", async () => {
  let release!: () => void
  const initialized = new Promise<void>(resolve => { release = resolve })
  let sweeps = 0
  const runtime = createProjectLifecycleRuntime({
    initialize: () => initialized,
    sweep: async () => { sweeps++ },
    schedule: () => () => {},
  })
  try {
    // Simulates the server/health path: start does not await initialization.
    runtime.start()
    assert.equal(projectLifecycleAvailable(), false)
    assert.throws(() => requireProjectLifecycleReady(), { code: "SERVICE_UNAVAILABLE" })
    release()
    await runtime.ready()
    assert.equal(projectLifecycleAvailable(), true)
    assert.doesNotThrow(() => requireProjectLifecycleReady())
    assert.equal(sweeps, 0)
  } finally { await runtime.stop() }
})

test("C7 runtime: initialization failure keeps project data unavailable and exposes a rejected readiness promise", async () => {
  const runtime = createProjectLifecycleRuntime({
    initialize: async () => { throw new Error("synthetic replay failure") },
    sweep: async () => {},
    schedule: () => () => {},
  })
  try {
    runtime.start()
    await assert.rejects(runtime.ready(), /Project data is temporarily unavailable/)
    assert.equal(projectLifecycleAvailable(), false)
    assert.throws(() => requireProjectLifecycleReady(), { code: "SERVICE_UNAVAILABLE" })
  } finally { await runtime.stop() }
})

test("C7 runtime: replay/recovery finishes before readiness (material repair ordering)", async () => {
  const order: string[] = []
  let releaseReplay!: () => void
  const replay = new Promise<void>(resolve => { releaseReplay = resolve })
  const runtime = createProjectLifecycleRuntime({
    initialize: async () => { order.push("journal-replay-start"); await replay; order.push("journal-replay-end") },
    sweep: async () => {},
    schedule: () => () => {},
  })
  try {
    runtime.start()
    const materialRepair = runtime.ready().then(() => order.push("material-repair"))
    order.push("startup-returned")
    // Let the background initialize task start without blocking startup.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(order, ["startup-returned", "journal-replay-start"])
    releaseReplay()
    await materialRepair
    assert.deepEqual(order, ["startup-returned", "journal-replay-start", "journal-replay-end", "material-repair"])
    assert.equal(projectLifecycleAvailable(), true)
  } finally {
    releaseReplay()
    await runtime.stop()
  }
})

test("C7 runtime: sweeps are single-flight, nudge is coalesced and stop waits for the current sweep", async () => {
  let releaseSweep!: () => void
  const running = new Promise<void>(resolve => { releaseSweep = resolve })
  let sweeps = 0
  let cancelled = 0
  const runtime = createProjectLifecycleRuntime({
    initialize: async () => {},
    sweep: async () => { sweeps++; await running },
    schedule: () => () => { cancelled++ },
  })
  try {
    runtime.start()
    await runtime.ready()
    const first = runtime.sweepNow()
    runtime.nudge()
    runtime.nudge()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(sweeps, 1)
    let stopped = false
    const stop = runtime.stop().then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(stopped, false, "stop must wait for the in-flight sweep transaction")
    releaseSweep()
    await first
    await stop
    assert.equal(stopped, true)
    assert.equal(cancelled, 1)
    assert.equal(runtime.nudge(), undefined)
  } finally { await runtime.stop() }
})

test("C7 runtime: a sweep failure is contained and does not revoke readiness", async () => {
  let sweeps = 0
  let scheduleTick!: () => void
  const runtime = createProjectLifecycleRuntime({
    initialize: async () => {},
    sweep: async () => { sweeps++; throw new Error("synthetic sweep failure") },
    schedule: tick => { scheduleTick = tick; return () => {} },
  })
  try {
    runtime.start()
    await runtime.ready()
    scheduleTick()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(sweeps, 1)
    assert.equal(projectLifecycleAvailable(), true)
    await runtime.stop()
  } finally { await runtime.stop() }
})

test("C7 configuration: frozen journal directory and interval boundaries fail closed", () => {
  assert.throws(() => projectDeletionJournalDirectory({ DATABASE_PROVIDER: "sqlite", SQLITE_PATH: "C:\\data\\equilens.sqlite", PROJECT_DELETION_JOURNAL_DIR: "" }), /Invalid project deletion journal directory/)
  assert.ok(projectDeletionJournalDirectory({ DATABASE_PROVIDER: "sqlite", SQLITE_PATH: "C:\\data\\equilens.sqlite" }).endsWith("project-deletion-journal"))
  assert.throws(() => projectDeletionJournalDirectory({
    DATABASE_PROVIDER: "gaussdb", GAUSSDB_HOST: "h", GAUSSDB_DATABASE: "d", GAUSSDB_USER: "u", GAUSSDB_PASSWORD: "p",
  }), /required/)
  assert.equal(projectLifecycleIntervalMs({}), 3_600_000)
  assert.equal(projectLifecycleIntervalMs({ PROJECT_LIFECYCLE_INTERVAL_MS: "60000" }), 60_000)
  for (const invalid of ["0", "59999", "1.5", "abc", " 60000", "-1"]) {
    assert.throws(() => projectLifecycleIntervalMs({ PROJECT_LIFECYCLE_INTERVAL_MS: invalid }), /Invalid project lifecycle interval configuration/)
  }
})
