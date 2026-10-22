import assert from "node:assert/strict"
import { test } from "node:test"
import { readCreatedSession } from "./session-transition"
import type { AnonymousSessionView } from "./session-types"

const active: AnonymousSessionView = { contextId: "fixture", state: "active", expiresAt: "2026-10-23T01:00:00Z", exportUntil: null, canRead: true, canCreate: true, canSave: true, canRestart: false, confirmation: null }

test("DB-08: first creation obtains the fixed deadline and supersedes pre-create session reads", async () => {
  const previous = new AbortController()
  const state = { generation: 2, controller: previous }
  const operation = new AbortController()
  const view = await readCreatedSession(state, operation.signal, async signal => {
    assert.equal(signal.aborted, false)
    assert.equal(previous.signal.aborted, true)
    return active
  })
  assert.equal(view?.state, "active")
  assert.equal(view?.expiresAt, active.expiresAt)
  assert.equal(state.generation, 3)
  assert.equal(operation.signal.aborted, false, "metadata refresh must not cancel its own create")
})

test("DB-08: canceled or superseded post-create metadata cannot replace the current view", async () => {
  const operation = new AbortController()
  const state: { generation: number; controller: AbortController | null } = { generation: 0, controller: null }
  let finish!: (view: AnonymousSessionView) => void
  const pending = readCreatedSession(state, operation.signal, () => new Promise(resolve => { finish = resolve }))
  state.generation++
  finish(active)
  assert.equal(await pending, null)
  operation.abort()
  let read = false
  await assert.rejects(readCreatedSession(state, operation.signal, async () => { read = true; return active }), { name: "AbortError" })
  assert.equal(read, false)
})

test("DB-08: post-create metadata errors remain distinct from successful document persistence", async () => {
  const state = { generation: 0, controller: null }
  await assert.rejects(readCreatedSession(state, new AbortController().signal, async () => { throw new Error("期限读取失败") }), /期限读取失败/)
})
