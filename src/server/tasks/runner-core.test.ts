import { BusinessError } from "../projects/errors"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createUnifiedRunner } from "./runner-core"
import { setupTasks, validRequest } from "./test-fixtures"

test("AC-15 revoked execution fails before executor runs", async () => {
  const fixture = await setupTasks()
  try {
    const submitted = await fixture.repository.submit("owner", "revoked", validRequest("material-parse"))
    let calls = 0
    const runner = createUnifiedRunner({ repository: fixture.repository, authorize: async () => { throw new BusinessError("FORBIDDEN", "拒绝") },
      executor: () => async () => { calls++; return { outcome: "success" } }, review: async () => {}, settle: async () => {},
      reserve: async () => {}, settleCall: async () => {} })
    await runner.tick()
    assert.equal(calls, 0)
    const task = await fixture.repository.get("owner", submitted.task.id)
    assert.equal(task.state, "failed")
    assert.equal(task.error?.code, "ACCESS_REVOKED")
  } finally { await fixture.close() }
})

test("AC-13 concurrent wake shares one slot; stop aborts active executor", async () => {
  const fixture = await setupTasks()
  try {
    await fixture.repository.submit("owner", "serial", validRequest("material-parse"))
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let reviewCalls = 0
    const runner = createUnifiedRunner({ repository: fixture.repository, authorize: async () => {},
      executor: () => async (_job, context) => {
        entered()
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }))
        return { outcome: "cancelled" }
      }, review: async () => { reviewCalls++ }, settle: async () => {}, reserve: async () => {}, settleCall: async () => {} })
    const work = runner.tick()
    await started
    await Promise.all([runner.tick(), runner.tick()])
    assert.equal(reviewCalls, 0)
    await runner.stop()
    await work
  } finally { await fixture.close() }
})

test("AC-13 stop during asynchronous claim prevents executor start", async () => {
  const fixture = await setupTasks()
  try {
    await fixture.repository.submit("owner", "stop-claim", validRequest("material-parse"))
    const job = await fixture.repository.claimNext()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let calls = 0
    const runner = createUnifiedRunner({ repository: {
      claimNext: async () => { entered(); await new Promise<void>(resolve => { release = resolve }); return job },
      heartbeat: (...args) => fixture.repository.heartbeat(...args), finish: (...args) => fixture.repository.finish(...args),
    }, authorize: async () => {}, executor: () => async () => { calls++; return { outcome: "success" } },
    review: async () => { calls++ }, settle: async () => {}, reserve: async () => {}, settleCall: async () => {} })
    const work = runner.tick()
    await started
    const stopping = runner.stop()
    release()
    await Promise.all([work, stopping])
    assert.equal(calls, 0)
    assert.equal((await fixture.repository.get("owner", job!.id)).state, "cancelled")
  } finally { await fixture.close() }
})

test("AC-13 authorization outage remains unavailable rather than revoked", async () => {
  const fixture = await setupTasks()
  try {
    const submitted = await fixture.repository.submit("owner", "outage", validRequest("material-parse"))
    let calls = 0
    const runner = createUnifiedRunner({ repository: fixture.repository,
      authorize: async () => { throw new BusinessError("SERVICE_UNAVAILABLE", "不可用") },
      executor: () => async () => { calls++; return { outcome: "success" } }, review: async () => {},
      settle: async () => {}, reserve: async () => {}, settleCall: async () => {} })
    await runner.tick()
    assert.equal(calls, 0)
    assert.equal((await fixture.repository.get("owner", submitted.task.id)).error?.code, "SERVICE_UNAVAILABLE")
  } finally { await fixture.close() }
})
