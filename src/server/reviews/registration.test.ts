import assert from "node:assert/strict"
import { test } from "node:test"
import type { ClaimedTask } from "../tasks/repository"
import { taskExecutorRegistry } from "../tasks/executors"
import type { TaskExecutor } from "../tasks/runner-core"
import { projectReviewExecutorRegistered, registerProjectReviewExecutor } from "./registration"

const job = { id: "task", kind: "contract-review" } as ClaimedTask
const context = { signal: new AbortController().signal } as Parameters<TaskExecutor>[1]

test("A4c registration: the review executor starts unregistered and is registered lazily by the explicit lifecycle", async () => {
  assert.equal(projectReviewExecutorRegistered(), false)
  assert.equal(taskExecutorRegistry.get("contract-review"), null)

  let factoryCalls = 0
  registerProjectReviewExecutor(() => {
    factoryCalls++
    return async () => ({ outcome: "success", resultSummary: "registered" })
  })
  assert.equal(projectReviewExecutorRegistered(), true)
  const executor = taskExecutorRegistry.get("contract-review")
  assert.ok(executor)
  assert.deepEqual(await executor(job, context), { outcome: "success", resultSummary: "registered" })
  assert.equal(factoryCalls, 1)
  assert.deepEqual(await executor(job, context), { outcome: "success", resultSummary: "registered" })
  assert.equal(factoryCalls, 2)

  // A second registration (for example a test double imported later) is a no-op.
  registerProjectReviewExecutor(() => async () => ({ outcome: "failed" }))
  assert.deepEqual(await taskExecutorRegistry.get("contract-review")!(job, context), { outcome: "success", resultSummary: "registered" })
})
