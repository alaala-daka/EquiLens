import assert from "node:assert/strict"
import { test } from "node:test"
import type { DocumentRecord } from "./types"
import { createDocumentListStore } from "./list-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const document: DocumentRecord = {
  id: "synthetic-doc", title: "合同", source: "authored", prompt: "",
  createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", currentRevision: "r1",
}

test("UI-04: refresh error retains the last successful list", async () => {
  let fail = false
  const store = createDocumentListStore(async () => {
    if (fail) throw new Error("合成网络失败")
    return [document]
  })
  await store.refresh()
  fail = true
  await store.refresh()
  assert.equal(store.getSnapshot().kind, "ready")
  assert.equal(store.getSnapshot().documents[0].id, document.id)
  assert.equal(store.getSnapshot().error, "合成网络失败")
})

test("UI-04/05: refresh response cannot erase a newly saved revision", async () => {
  const late = deferred<DocumentRecord[]>()
  let calls = 0
  const store = createDocumentListStore(() => ++calls === 1 ? Promise.resolve([document]) : late.promise)
  await store.refresh()
  const pending = store.refresh()
  store.upsert({ ...document, title: "已保存修订", currentRevision: "r2" })
  late.resolve([document])
  await pending
  assert.equal(store.getSnapshot().documents[0].currentRevision, "r2")
})

test("UI-04: initial failure stays distinct from empty success and retries", async () => {
  let fail = true
  const store = createDocumentListStore(async () => {
    if (fail) throw new Error("初次读取失败")
    return []
  })
  await store.refresh()
  assert.equal(store.getSnapshot().kind, "initial-error")
  assert.equal(store.getSnapshot().error, "初次读取失败")
  fail = false
  await store.refresh()
  assert.equal(store.getSnapshot().kind, "ready")
  assert.equal(store.getSnapshot().error, null)
  assert.deepEqual(store.getSnapshot().documents, [])
})

test("UI-04: older failure cannot replace a newer successful request", async () => {
  const first = deferred<DocumentRecord[]>()
  const second = deferred<DocumentRecord[]>()
  let calls = 0
  const store = createDocumentListStore(() => ++calls === 1 ? first.promise : second.promise)
  const older = store.refresh()
  const newer = store.refresh()
  second.resolve([{ ...document, id: "newer" }])
  await newer
  first.reject(new Error("过期错误"))
  await older
  assert.equal(store.getSnapshot().documents[0].id, "newer")
  assert.equal(store.getSnapshot().error, null)
})

test("UI-04/05: cancellation aborts and invalidates requests while allowing setup again", async () => {
  const pending = deferred<DocumentRecord[]>()
  const signals: AbortSignal[] = []
  const store = createDocumentListStore(signal => {
    signals.push(signal)
    return signals.length === 1 ? pending.promise : Promise.resolve([document])
  })
  const initial = store.getSnapshot()
  assert.equal(signals.length, 0)
  assert.equal(store.getSnapshot(), initial)
  const old = store.refresh()
  store.cancel()
  assert.equal(signals[0].aborted, true)
  await store.refresh()
  pending.resolve([])
  await old
  assert.equal(store.getSnapshot().documents[0].id, document.id)
})

test("UI-04: refresh keeps data, reset invalidates responses, and unsubscribe removes listeners", async () => {
  const late = deferred<DocumentRecord[]>()
  let calls = 0
  const store = createDocumentListStore(() => ++calls === 1 ? Promise.resolve([document]) : late.promise)
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })
  await store.refresh()
  const pending = store.refresh()
  assert.equal(store.getSnapshot().kind, "ready")
  assert.deepEqual(store.getSnapshot().documents, [document])
  assert.equal("refreshing" in store.getSnapshot() && store.getSnapshot().refreshing, true)
  unsubscribe()
  const count = notifications
  store.reset()
  late.resolve([document])
  await pending
  assert.equal(store.getSnapshot().kind, "loading")
  assert.deepEqual(store.getSnapshot().documents, [])
  assert.equal(notifications, count)
})
