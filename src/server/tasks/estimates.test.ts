import assert from "node:assert/strict"
import { test } from "node:test"
import { estimateTaskCall } from "./estimates"
import { registerTaskExecutor, taskExecutorRegistry } from "./executors"

test("AC-23 estimates reject zero-call kinds and invalid sequence", () => {
  assert.throws(() => estimateTaskCall("material-parse", 1))
  assert.throws(() => estimateTaskCall("contract-review", 26))
  assert.throws(() => estimateTaskCall("contract-review", 0))
  assert.deepEqual(estimateTaskCall("contract-review", 1), { costFen: 120, timeMs: 90000 })
})

test("executor registry advertises only explicitly registered executors", () => {
  assert.equal(taskExecutorRegistry.get("material-parse"), null)
  const executor = async () => ({ outcome: "success" as const })
  registerTaskExecutor("material-parse", executor)
  assert.equal(taskExecutorRegistry.get("material-parse"), executor)
  assert.deepEqual(taskExecutorRegistry.available(), ["material-parse"])
})
