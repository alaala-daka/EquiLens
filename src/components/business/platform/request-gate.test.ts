import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequestGate } from "./request-gate"

test("C1: independent gates cannot abort or invalidate each other", () => {
  const list = createRequestGate()
  const switching = createRequestGate()
  const switchRequest = switching.begin()
  const listRequest = list.begin()

  // A list refresh must not abort the in-flight switch (the fixed regression).
  assert.equal(switchRequest.signal.aborted, false)
  assert.equal(switching.isCurrent(switchRequest.ticket), true)
  assert.equal(listRequest.signal.aborted, false)

  // A second list refresh invalidates only the first list request.
  const secondList = list.begin()
  assert.equal(listRequest.signal.aborted, true)
  assert.equal(list.isCurrent(listRequest.ticket), false)
  assert.equal(list.isCurrent(secondList.ticket), true)
  assert.equal(switching.isCurrent(switchRequest.ticket), true)
  assert.equal(switchRequest.signal.aborted, false)
})

test("C1: switching busy is released by its own latest switch even after a list refresh", () => {
  const list = createRequestGate()
  const switching = createRequestGate()
  const request = switching.begin()
  // Simulate the focus refresh racing the switch request.
  const refresh = list.begin()
  list.finish(refresh.ticket)
  assert.equal(switching.isCurrent(request.ticket), true)

  // The switch finally block always runs its own release here.
  switching.finish(request.ticket)
  assert.equal(switching.isCurrent(request.ticket), true, "finish does not change the gate ticket")
})

test("C1: a superseded switch leaves busy cleanup to the newer switch", () => {
  const switching = createRequestGate()
  const first = switching.begin()
  const second = switching.begin()
  assert.equal(first.signal.aborted, true)
  assert.equal(switching.isCurrent(first.ticket), false)
  assert.equal(switching.isCurrent(second.ticket), true)

  // The stale switch must not mark the newer switch idle or clear its controller.
  switching.finish(first.ticket)
  assert.equal(switching.isCurrent(second.ticket), true)
  assert.equal(second.signal.aborted, false)

  switching.cancel()
  assert.equal(second.signal.aborted, true)
  assert.equal(switching.isCurrent(second.ticket), false)
})

test("C1: cancel aborts and invalidates the current request", () => {
  const gate = createRequestGate()
  const request = gate.begin()
  assert.equal(request.signal.aborted, false)
  gate.cancel()
  assert.equal(request.signal.aborted, true)
  assert.equal(gate.isCurrent(request.ticket), false)
})
