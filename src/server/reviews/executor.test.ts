import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createProjectReviewExecutor, type ProjectReviewRunner } from "./executor"
import {
  accountId, executorContext, executorDependencies, failedResult, humanReviewValue, invalidCitationResult,
  partialResult, projectId, setupReview, successResult, testAuthorizer, testIdentity,
} from "./test-fixtures"

const revoked = () => Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })

test("A4c executor: success saves one immutable machine result with fragment sources and material dependencies", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    let received: Parameters<ProjectReviewRunner>[0] | undefined
    const runner: ProjectReviewRunner = async input => {
      received = input
      await input.onExchange({ callNumber: 1, request: {}, response: {} })
      return successResult(input)
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job, executorContext())
    assert.equal(outcome.outcome, "success")
    assert.match(String(outcome.resultSummary), /"resultId"/)
    assert.ok(received)
    assert.equal(received.maxCalls, 25)
    assert.equal(received.context.scene, "auto")
    assert.equal(received.documentVersionId, fixture.materials[0].versionId)
    assert.equal(received.parseSnapshotId, fixture.materials[0].snapshotId)
    assert.equal(received.textSha256, createHash("sha256").update(received.paragraphs.map(paragraph => paragraph.text).join("\n")).digest("hex"))
    assert.ok(received.env)

    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 1)
    const view = views[0]
    assert.equal(view.kind, "contract-review")
    assert.equal(view.origin, "machine")
    assert.equal(view.validation.status, "valid")
    assert.equal((view.value as { status: string }).status, "success")
    assert.ok(view.sources.length >= 1)
    assert.equal(view.sources[0].snapshotId, fixture.materials[0].snapshotId)
    assert.match(view.sources[0].fragmentId, /^fragment-1-/)
    assert.deepEqual(view.machineOutput, view.value)
    assert.equal(view.provenance?.taskId, job.id)
    assert.equal(view.provenance?.attempt, job.attempt)
    assert.ok(view.dependencies.some(dependency => dependency.kind === "material" && dependency.versionId === fixture.materials[0].versionId))
    assert.ok(view.dependencies.some(dependency => dependency.kind === "rule" && dependency.versionId === "0.2.0-draft"))
    // The executor never writes the terminal task state; the unified runner owns it.
    assert.equal((await fixture.tasks.get(accountId, job.id)).state, "running")
  } finally { await fixture.close() }
})

test("A4c executor: each model exchange settles measured time instead of holding a 90s reservation", async () => {
  const fixture = await setupReview()
  try {
    const reservations: number[] = []
    const settlements: Array<{ call: number; timeMs: number }> = []
    const runner: ProjectReviewRunner = async input => {
      for (let call = 1; call <= 8; call++) {
        await input.onBeforeCall({ callNumber: call })
        await new Promise(resolve => setTimeout(resolve, 5))
        await input.onExchange({ callNumber: call, request: {}, response: {} })
      }
      return successResult(input)
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(
      await fixture.claim(),
      executorContext({
        reserveCall: async callNumber => { reservations.push(callNumber) },
        settleCall: async (callNumber, usage) => { settlements.push({ call: callNumber, timeMs: Number(usage?.timeMs ?? -1) }) },
      }),
    )
    assert.equal(outcome.outcome, "success")
    assert.deepEqual(reservations, [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(settlements.length, 8)
    for (const [index, settlement] of settlements.entries()) {
      assert.equal(settlement.call, index + 1)
      assert.ok(settlement.timeMs >= 0 && settlement.timeMs < 89000)
    }
  } finally { await fixture.close() }
})

test("A4c executor: partial coverage is saved as a partial machine result, not as success or no-risk", async () => {
  const fixture = await setupReview({ coverage: { status: "partial", findings: [{ code: "embedded_image", location: "图片 1 处" }], pageCount: null, textLength: 30 } })
  try {
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner: async input => partialResult(input) }))(
      await fixture.claim(), executorContext(),
    )
    assert.equal(outcome.outcome, "partial")
    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 1)
    assert.equal(views[0].validation.status, "partial")
    assert.equal((views[0].value as { status: string }).status, "partial")
    assert.ok(views[0].sources.length >= 1)
    // A partial result cannot be approved as a completed review.
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      ...views[0], decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
  } finally { await fixture.close() }
})

test("A4c executor: a citation that is not verbatim in a project fragment fails without saving a result", async () => {
  const fixture = await setupReview()
  try {
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner: async input => invalidCitationResult(input) }))(
      await fixture.claim(), executorContext(),
    )
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "INVALID_SOURCE")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("A4c executor: revoked access fails before the model runner is invoked", async () => {
  const fixture = await setupReview()
  try {
    let runnerCalls = 0
    const runner: ProjectReviewRunner = async input => { runnerCalls++; return successResult(input) }
    const executor = createProjectReviewExecutor(executorDependencies(fixture, { runner }))
    await assert.rejects(executor(await fixture.claim(), executorContext({ refreshAccess: async () => { throw revoked() } })), { code: "ACCESS_REVOKED" })
    assert.equal(runnerCalls, 0)
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("A4c executor: expired retention fails before the model runner is invoked", async () => {
  const fixture = await setupReview({ materialRetention: "2020-01-01" })
  try {
    let runnerCalls = 0
    const runner: ProjectReviewRunner = async input => { runnerCalls++; return successResult(input) }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner, now: () => new Date("2026-10-29T00:00:00.000Z") }))(
      await fixture.claim(), executorContext(),
    )
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RETENTION_EXPIRED")
    assert.equal(runnerCalls, 0)
  } finally { await fixture.close() }
})

test("A4c executor: a refused budget reservation stops the task without saving a result", async () => {
  const fixture = await setupReview()
  try {
    const runner: ProjectReviewRunner = async input => {
      try { await input.onBeforeCall({ callNumber: 1 }) } catch { /* the real runner records the failure and returns a result */ }
      return successResult(input)
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(
      await fixture.claim(),
      executorContext({ reserveCall: async () => { throw Object.assign(new Error("项目费用预算未登记，不能发起外部请求。"), { code: "BUDGET_EXHAUSTED" }) } }),
    )
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "REVIEW_BUDGET_EXHAUSTED")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("A4c executor: recovered attempts continue the persistent call counter and bounded remaining calls", async () => {
  const fixture = await setupReview()
  try {
    const claimed = await fixture.claim()
    const job = { ...claimed, callsUsed: 2 }
    const reserved: number[] = []
    const runner: ProjectReviewRunner = async input => {
      await input.onBeforeCall({ callNumber: 1 })
      await input.onBeforeCall({ callNumber: 2 })
      assert.equal(input.maxCalls, 23)
      return successResult(input)
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(
      job,
      executorContext({ reserveCall: async callNumber => { reserved.push(callNumber) } }),
    )
    assert.equal(outcome.outcome, "success")
    assert.deepEqual(reserved, [3, 4])
  } finally { await fixture.close() }
})

test("A4c executor: a stale execution token cannot publish a machine result", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    await fixture.database.transaction(async connection => {
      await connection.query("UPDATE equilens_tasks SET execution_token='replacement' WHERE id=$1", [job.id])
    })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner: async input => successResult(input) }))(job, executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "CONFLICT")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("A4c executor: missing unreviewed-material consent fails without a model call", async () => {
  const fixture = await setupReview()
  try {
    let runnerCalls = 0
    const runner: ProjectReviewRunner = async input => { runnerCalls++; return successResult(input) }
    const job = await fixture.claim(undefined, { unreviewedMaterialsConsent: false })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job, executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "UNREVIEWED_MATERIALS_CONSENT")
    assert.equal(runnerCalls, 0)
  } finally { await fixture.close() }
})

test("A4c executor: a failed review is not saved as a machine result", async () => {
  const fixture = await setupReview()
  try {
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner: async input => failedResult(input) }))(await fixture.claim(), executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "AI_UPSTREAM_ERROR")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("A4c executor: a machine result never overwrites or replaces a human result version", async () => {
  const fixture = await setupReview()
  try {
    const human = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "contract-review", baseVersionId: "", operationId: "human-1", reason: "人工保存",
      value: humanReviewValue(), sources: [], dependencies: [],
    })
    assert.equal(human.validation.status, "valid")
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner: async input => successResult(input) }))(await fixture.claim(), executorContext())
    assert.equal(outcome.outcome, "success")
    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 2)
    const currentHuman = await fixture.results.get(testIdentity, testAuthorizer, projectId, human.resultId)
    assert.equal(currentHuman.versionId, human.versionId)
    assert.equal((currentHuman.value as { documentTitle: string }).documentTitle, "人工成果")
    const machine = views.find(view => view.origin === "machine")
    assert.ok(machine)
    assert.notEqual(machine.resultId, human.resultId)
  } finally { await fixture.close() }
})

test("A4c executor: a runner output bound to another input is rejected as a mismatch", async () => {
  const fixture = await setupReview()
  try {
    const runner: ProjectReviewRunner = async input => ({ ...successResult(input), input: { ...successResult(input).input, parseSnapshotId: "other-snapshot" } })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(await fixture.claim(), executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RESULT_MISMATCH")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})
