import assert from "node:assert/strict"
import { test } from "node:test"
import { createEngineLoad } from "./engine-lifecycle"

const delay = () => new Promise((resolve) => setTimeout(resolve, 15))

test("WD-07: readiness cancels the deadline and succeeds only once", async () => {
  let timeouts = 0
  const load = createEngineLoad({ timeoutMs: 5, onTimeout: () => { timeouts++ } })
  assert.equal(load.ready(), true)
  assert.equal(load.ready(), false)
  await delay()
  assert.equal(timeouts, 0)
  assert.equal(load.isCurrent(), true)
  assert.equal(load.signal.aborted, false)
  load.dispose()
})

test("WD-07: dispose is idempotent and rejects late readiness", async () => {
  let timeouts = 0
  const load = createEngineLoad({ timeoutMs: 5, onTimeout: () => { timeouts++ } })
  load.dispose()
  load.dispose()
  assert.equal(load.signal.aborted, true)
  assert.equal(load.isCurrent(), false)
  assert.equal(load.ready(), false)
  await delay()
  assert.equal(timeouts, 0)
})

test("WD-07: a timeout aborts once and cannot activate a late engine", async () => {
  let timeouts = 0
  const load = createEngineLoad({ timeoutMs: 5, onTimeout: () => { timeouts++ } })
  await delay()
  assert.equal(timeouts, 1)
  assert.equal(load.signal.aborted, true)
  assert.equal(load.isCurrent(), false)
  assert.equal(load.ready(), false)
  let constructed = false
  await Promise.resolve().then(() => { if (load.isCurrent()) constructed = true })
  assert.equal(constructed, false)
  load.dispose()
  await delay()
  assert.equal(timeouts, 1)
})

test("WD-07: an old load cannot activate or invalidate a replacement", () => {
  const old = createEngineLoad({ timeoutMs: 100, onTimeout: () => assert.fail("old timeout") })
  old.dispose()
  const current = createEngineLoad({ timeoutMs: 100, onTimeout: () => assert.fail("current timeout") })
  assert.equal(old.ready(), false)
  assert.equal(current.ready(), true)
  old.dispose()
  assert.equal(current.isCurrent(), true)
  current.dispose()
})
