import assert from "node:assert/strict"
import test from "node:test"
import { createProtectedResources } from "./protected-resources"
test("revocation aborts requests, revokes URLs and prevents stale refill or renewed access", () => {
  let cleared = 0
  const scope = createProtectedResources(() => { cleared++ })
  const request = scope.begin()
  const url = URL.createObjectURL(new Blob(["synthetic"]))
  scope.trackUrl(url)
  scope.clear()
  assert.equal(request.signal.aborted, true)
  assert.equal(request.current(), false)
  assert.equal(scope.allowed(), false)
  assert.equal(cleared, 1)
  assert.throws(() => scope.begin())
  request.finish()
})
