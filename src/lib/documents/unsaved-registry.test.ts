import assert from "node:assert/strict"
import { test } from "node:test"
import { createUnsavedRegistry } from "./unsaved-registry"

function entry(id: string, calls: string[], outcome: () => Promise<boolean> | boolean = () => true) {
  return {
    id,
    label: `未保存-${id}`,
    save: async () => { calls.push(id); return outcome() },
  }
}

test("A2/UI-13: registry tracks registered unsaved objects and stable snapshots", () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  const initial = registry.getSnapshot()
  assert.strictEqual(registry.getSnapshot(), initial)
  assert.equal(registry.hasUnsaved(), false)

  let notifications = 0
  const unsubscribe = registry.subscribe(() => { notifications++ })
  const unregister = registry.register(entry("fact", calls))
  assert.equal(registry.hasUnsaved(), true)
  assert.deepEqual(registry.getSnapshot().entries, [{ id: "fact", label: "未保存-fact" }])
  assert.equal(notifications, 1)
  assert.notStrictEqual(registry.getSnapshot(), initial)

  unregister()
  assert.equal(registry.hasUnsaved(), false)
  assert.equal(notifications, 2)
  unsubscribe()
  registry.register(entry("payment", calls))
  assert.equal(notifications, 2)
})

test("A2/UI-13: saveAll saves in registration order and drops confirmed entries", async () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  registry.register(entry("fact", calls))
  registry.register(entry("payment", calls))
  const outcome = await registry.saveAll()
  assert.deepEqual(calls, ["fact", "payment"])
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.failures, [])
  assert.equal(registry.hasUnsaved(), false)
  assert.deepEqual(registry.getSnapshot().entries, [])
})

test("A2/UI-13: partial failure keeps only the failed entry and retry never duplicates a saved version", async () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  let fail = true
  registry.register(entry("fact", calls))
  registry.register(entry("payment", calls, () => { if (fail) throw new Error("保存失败"); return true }))
  const outcome = await registry.saveAll()
  assert.equal(outcome.ok, false)
  assert.deepEqual(calls, ["fact", "payment"])
  assert.equal(registry.hasUnsaved(), true)
  assert.deepEqual(registry.getSnapshot().entries, [{ id: "payment", label: "未保存-payment" }])
  assert.equal(outcome.failures[0].id, "payment")
  assert.equal(outcome.failures[0].message, "保存失败")

  fail = false
  const retry = await registry.saveAll()
  assert.equal(retry.ok, true)
  // The fact already committed; retrying must not create a second version.
  assert.deepEqual(calls, ["fact", "payment", "payment"])
  assert.equal(registry.hasUnsaved(), false)
})

test("A2/UI-13: an unresolved save keeps the entry and reports failure", async () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  registry.register(entry("result", calls, () => false))
  const outcome = await registry.saveAll()
  assert.equal(outcome.ok, false)
  assert.equal(registry.hasUnsaved(), true)
  assert.equal(outcome.failures[0].message, "未确认保存成功，请重试。")
})

test("A2/UI-13: concurrent saveAll shares one flight and saves each object once", async () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  registry.register({ id: "task", label: "任务条件", save: async () => { calls.push("task"); await gate; return true } })
  const first = registry.saveAll()
  const second = registry.saveAll()
  assert.strictEqual(first, second)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.deepEqual(calls, ["task"])
})

test("A2/UI-13: an object registered during saving blocks navigation and is saved by the next pass", async () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  let added = false
  registry.register({
    id: "fact",
    label: "事实",
    save: async () => {
      calls.push("fact")
      if (!added) { added = true; registry.register(entry("payment", calls)) }
      return true
    },
  })
  const outcome = await registry.saveAll()
  assert.equal(outcome.ok, false)
  assert.equal(registry.hasUnsaved(), true)
  const retry = await registry.saveAll()
  assert.equal(retry.ok, true)
  assert.deepEqual(calls, ["fact", "payment"])
  assert.equal(registry.hasUnsaved(), false)
})

test("A2/UI-13: stale unregister cannot remove a newer registration", () => {
  const registry = createUnsavedRegistry()
  const calls: string[] = []
  const first = entry("ledger", calls)
  const unregisterFirst = registry.register(first)
  registry.register({ ...entry("ledger", calls), label: "款项-新编辑" })
  unregisterFirst()
  assert.equal(registry.hasUnsaved(), true)
  assert.deepEqual(registry.getSnapshot().entries, [{ id: "ledger", label: "款项-新编辑" }])
})

test("A2/UI-13: discardAll drops pending entries without saving and tolerates discard failures", () => {
  const registry = createUnsavedRegistry()
  const discarded: string[] = []
  registry.register({ id: "a", label: "A", save: async () => true, discard: () => { discarded.push("a") } })
  registry.register({ id: "b", label: "B", save: async () => true, discard: () => { throw new Error("已卸载") } })
  assert.equal(registry.hasUnsaved(), true)
  registry.discardAll()
  assert.deepEqual(discarded, ["a"])
  assert.equal(registry.hasUnsaved(), false)
  assert.deepEqual(registry.getSnapshot().failures, [])
})
