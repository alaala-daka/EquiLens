import assert from "node:assert/strict"
import { test } from "node:test"
import type { ParseCoverage } from "../materials/types"
import type { ClaimedTask } from "../tasks/repository"
import { compareRequirements } from "./compare"
import { createBidRequirementsExecutor, createBidVerificationExecutor, PARTIAL_COVERAGE_WARNING } from "./executor"
import { createBidRequirementExtractor } from "./extractor"
import {
  asOf, executorContext, projectId, setupVerification, testAuthorizer, testIdentity,
  type VerificationFixture,
} from "./verification-test-fixtures"

/**
 * C4-VERIFY executor contract (plan §5): deterministic comparison with no model
 * calls, pinned requirement-set/material/record inputs, revocation/retention
 * stops before writes, one new machine result per run, and audit-saved invalid
 * results reported as failed tasks.
 *
 * The fixture claims tasks and simulates the unified runner's terminal write so
 * sequential runs in one project (including re-runs) are possible.
 */
const revoked = () => Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })

async function executeVerification(
  fixture: VerificationFixture,
  job: ClaimedTask,
  dependencies: Parameters<typeof fixture.executorDependencies>[0] = {},
  context: Parameters<typeof executorContext>[0] = {},
) {
  const outcome = await createBidVerificationExecutor(fixture.executorDependencies(dependencies))(job, executorContext(context))
  await fixture.finishJob(job, outcome)
  return outcome
}

async function executeRequirements(
  fixture: VerificationFixture,
  job: ClaimedTask,
  dependencies: Parameters<typeof fixture.requirementsExecutorDependencies>[0] = {},
  context: Parameters<typeof executorContext>[0] = {},
) {
  const outcome = await createBidRequirementsExecutor(fixture.requirementsExecutorDependencies(dependencies))(job, executorContext(context))
  await fixture.finishJob(job, outcome)
  return outcome
}

async function prepared() {
  const fixture = await setupVerification()
  const tender = fixture.materials[0]
  const certificate = fixture.materials[1]
  fixture.addFields(certificate, [
    { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
    { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
    { fieldKey: "certificate_kind", valueText: "营业执照" },
  ])
  const requirementSet = await fixture.saveRequirementSet()
  const setRef = { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 }
  const materialRef = { materialVersionId: certificate.versionId, sha256: certificate.sha256 }
  return { fixture, tender, certificate, requirementSet, setRef, materialRef }
}

test("bid-verification executor: saves one deterministic machine result with embedded snapshots and dependencies", async () => {
  const { fixture, tender, certificate, setRef, materialRef } = await prepared()
  try {
    const outcome = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }))
    assert.equal(outcome.outcome, "success")
    const views = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification")
    assert.equal(views.length, 1)
    const view = views[0]
    assert.equal(view.origin, "machine")
    assert.equal(view.validation.status, "valid")
    assert.deepEqual(view.machineOutput, view.value)
    assert.ok(view.sources.length >= 1)
    assert.ok(view.sources.every(source => source.snapshotId === tender.snapshotId))
    assert.ok(view.dependencies.some(dependency => dependency.kind === "result" && dependency.id === setRef.id))
    assert.ok(view.dependencies.some(dependency => dependency.kind === "material" && dependency.versionId === certificate.versionId))
    const value = view.value as {
      status: string; asOf: string; requirementSet: { id: string; sha256: string; requirements: unknown[] }
      materials: Array<{ versionId: string; sha256: string }>
      records: unknown[]
      items: Array<{ materialCheck: string; externalCheck: string; evidence: unknown[] }>
      coverage: { requirements: number; externalUnverified: number }
    }
    assert.equal(value.asOf, asOf)
    assert.equal(value.status, "success")
    assert.equal(value.requirementSet.id, setRef.id)
    assert.equal(value.requirementSet.sha256, setRef.sha256)
    assert.equal(value.requirementSet.requirements.length, 1)
    assert.equal(value.materials[0].versionId, certificate.versionId)
    assert.equal(value.materials[0].sha256, certificate.sha256)
    assert.deepEqual(value.records, [])
    assert.equal(value.items[0].materialCheck, "满足材料要求")
    assert.equal(value.items[0].externalCheck, "未核验")
    assert.ok(value.items[0].evidence.length >= 1)
    assert.equal(value.coverage.requirements, 1)
    assert.equal(value.coverage.externalUnverified, 1)
    // Distinct resultId from the requirement set; the machine write is a new result.
    assert.notEqual(view.resultId, setRef.id)
  } finally { await fixture.close() }
})

test("bid-verification executor: re-running creates a new resultId and keeps the old result readable", async () => {
  const { fixture, setRef, materialRef } = await prepared()
  try {
    const first = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }))
    assert.equal(first.outcome, "success")
    const second = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }))
    assert.equal(second.outcome, "success")
    const views = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification")
    assert.equal(views.length, 2)
    assert.notEqual(views[0].resultId, views[1].resultId)
    const firstSummary = JSON.parse(String(first.resultSummary)) as { resultId: string }
    const oldView = await fixture.results.get(testIdentity, testAuthorizer, projectId, firstSummary.resultId)
    assert.equal(oldView.validation.status, "valid")
  } finally { await fixture.close() }
})

test("bid-verification executor: revoked access stops before any result write", async () => {
  const { fixture, setRef, materialRef } = await prepared()
  try {
    const job = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    const executor = createBidVerificationExecutor(fixture.executorDependencies())
    await assert.rejects(
      executor(job, executorContext({ refreshAccess: async () => { throw revoked() } })),
      { code: "ACCESS_REVOKED" },
    )
    await fixture.finishJob(job, { outcome: "cancelled" })
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification").length, 0)
  } finally { await fixture.close() }
})

test("bid-verification executor: expired material retention fails before comparison and writes nothing", async () => {
  const { fixture, certificate, setRef, materialRef } = await prepared()
  try {
    await fixture.database.transaction(async connection => {
      await connection.query("UPDATE equilens_materials SET retention_until='2020-01-01' WHERE id=$1", [certificate.materialId])
    })
    const outcome = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }))
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RETENTION_EXPIRED")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification").length, 0)
  } finally { await fixture.close() }
})

test("bid-verification executor: a stale execution token cannot publish the machine result", async () => {
  const { fixture, setRef, materialRef } = await prepared()
  try {
    const job = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    await fixture.database.transaction(async connection => {
      await connection.query("UPDATE equilens_tasks SET execution_token='replacement' WHERE id=$1", [job.id])
    })
    const outcome = await createBidVerificationExecutor(fixture.executorDependencies())(job, executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "CONFLICT")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification").length, 0)
  } finally { await fixture.close() }
})

test("bid-verification executor: requirement-set digest mismatch or an unconfirmed set is rejected before saving", async () => {
  const { fixture, setRef, materialRef } = await prepared()
  try {
    const tampered = { ...setRef, sha256: "0".repeat(64) }
    const outcome = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: tampered, materials: [materialRef] }))
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "INVALID_SOURCE")
    // A candidate (unconfirmed) requirement set can be saved but never compared.
    const candidateValue = fixture.requirementSetValue()
    const candidate = await fixture.saveRequirementSet({
      value: { ...candidateValue, status: "candidate", requirements: candidateValue.requirements.map(requirement => ({ ...requirement, status: "pending" as const })) },
      operationId: "candidate-set",
    })
    const notReady = await executeVerification(fixture, await fixture.submitVerificationTask({
      requirementSet: { id: candidate.resultId, versionId: candidate.versionId, sha256: candidate.sha256 },
      materials: [materialRef],
    }))
    assert.equal(notReady.outcome, "failed")
    assert.equal(notReady.errorCode, "REQUIREMENT_SET_NOT_READY")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification").length, 0)
  } finally { await fixture.close() }
})

test("bid-verification executor: external records are pinned by digest; unknown or tampered records are rejected", async () => {
  const { fixture, certificate, setRef, materialRef } = await prepared()
  try {
    // First comparison without records: the honest 未核验 baseline.
    const first = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }))
    assert.equal(first.outcome, "success")
    const baseline = JSON.parse(String(first.resultSummary)) as { resultId: string; versionId: string; sha256: string }
    const appended = await fixture.service.recordExternalVerification(testIdentity, testAuthorizer, {
      projectId,
      resultId: baseline.resultId,
      versionId: baseline.versionId,
      sha256: baseline.sha256,
      requirementId: "req-1",
      subject: "华建机电安装有限公司",
      certificateNo: "91310000MA1FL0XX2A",
      source: "全国建筑市场监管公共服务平台",
      queriedAt: "2026-10-29T00:00:00.000Z",
      queryConditions: "按统一社会信用代码查询",
      conclusion: "matched",
      proofMaterialVersionId: certificate.versionId,
    })
    // A second comparison that pins exactly this record becomes a matched external state.
    const pinned = await executeVerification(fixture, await fixture.submitVerificationTask({
      requirementSet: setRef, materials: [materialRef],
      externalRecords: [{ recordId: appended.recordId, sha256: appended.sha256 }],
    }))
    assert.equal(pinned.outcome, "success")
    const pinnedView = await fixture.results.get(testIdentity, testAuthorizer, projectId, (JSON.parse(String(pinned.resultSummary)) as { resultId: string }).resultId)
    assert.equal((pinnedView.value as { items: Array<{ externalCheck: string }> }).items[0].externalCheck, "人工查询记录匹配")
    // The earlier saved value is untouched: appending a record never rewrites history.
    const oldView = await fixture.results.get(testIdentity, testAuthorizer, projectId, baseline.resultId)
    assert.equal((oldView.value as { items: Array<{ externalCheck: string }> }).items[0].externalCheck, "未核验")
    // Unknown record id and tampered digest both fail before any write.
    for (const externalRecords of [
      [{ recordId: "unknown-record", sha256: appended.sha256 }],
      [{ recordId: appended.recordId, sha256: "f".repeat(64) }],
    ]) {
      const outcome = await executeVerification(fixture, await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef], externalRecords }))
      assert.equal(outcome.outcome, "failed")
      assert.equal(outcome.errorCode, "INVALID_SOURCE")
    }
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification").length, 2)
  } finally { await fixture.close() }
})

test("bid-verification executor: an invalid machine result is saved for audit but the task fails and cannot be approved", async () => {
  const { fixture, setRef, materialRef } = await prepared()
  try {
    const outcome = await executeVerification(
      fixture,
      await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] }),
      {
        compare: input => {
          const compared = compareRequirements(input)
          compared.items[0].externalCheck = "人工查询记录匹配"
          return compared
        },
      },
    )
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RESULT_INVALID")
    const saved = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification")
    assert.equal(saved.length, 1)
    assert.equal(saved[0].validation.status, "invalid")
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      ...saved[0], decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
  } finally { await fixture.close() }
})

test("bid-requirements executor: model candidates are saved as pending candidates only, never confirmed", async () => {
  const fixture = await setupVerification()
  try {
    const tender = fixture.materials[0]
    let received: { maxCalls: number; complete: boolean } | undefined
    const extractor = async (input: { maxCalls: number; complete: boolean }) => {
      received = { maxCalls: input.maxCalls, complete: input.complete }
      return { candidates: [
        {
          subject: "投标人", quote: tender.fragments[0].text, nature: "资格否决",
          field: "subject_name", operator: "eq", value: "华建机电安装有限公司",
          asOfRule: "task_as_of", materialRelation: "企业营业执照",
        },
        { subject: "投标人", quote: "材料中不存在的引文", nature: "一般提交", materialRelation: "营业执照" },
      ] }
    }
    const outcome = await executeRequirements(fixture, await fixture.submitRequirementsTask(), { extractor })
    assert.equal(outcome.outcome, "success")
    assert.ok(received)
    assert.equal(received.maxCalls, 2)
    const views = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-requirements")
    assert.equal(views.length, 1)
    assert.equal(views[0].origin, "machine")
    assert.equal(views[0].validation.status, "partial")
    const value = views[0].value as { status: string; requirements: Array<{ status: string; nature: string }>; rejected: unknown[] }
    assert.equal(value.status, "candidate")
    assert.equal(value.requirements.length, 1)
    assert.equal(value.requirements[0].status, "pending")
    assert.ok(value.rejected.length >= 1)
    assert.ok(views[0].sources.length >= 1)
    assert.ok(views[0].dependencies.some(dependency => dependency.kind === "material"))
  } finally { await fixture.close() }
})

test("bid-requirements executor: extractor failure or no usable candidates saves nothing", async () => {
  const fixture = await setupVerification()
  try {
    const failure = await executeRequirements(fixture, await fixture.submitRequirementsTask(), {
      extractor: async () => { throw Object.assign(new Error("模型失败"), { code: "AI_UPSTREAM_ERROR" }) },
    })
    assert.equal(failure.outcome, "failed")
    assert.equal(failure.errorCode, "EXTRACTOR_FAILED")
    const empty = await executeRequirements(fixture, await fixture.submitRequirementsTask(), {
      extractor: async () => ({ candidates: [] }),
    })
    assert.equal(empty.outcome, "failed")
    assert.equal(empty.errorCode, "NO_REQUIREMENTS")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("bid-requirements executor: revocation and budget failures stop before saving", async () => {
  const fixture = await setupVerification()
  try {
    let extractorCalls = 0
    const extractor = async () => { extractorCalls++; return { candidates: [] } }
    const revokedJob = await fixture.submitRequirementsTask()
    await assert.rejects(
      createBidRequirementsExecutor(fixture.requirementsExecutorDependencies({ extractor }))(
        revokedJob,
        executorContext({ refreshAccess: async () => { throw revoked() } }),
      ),
      { code: "ACCESS_REVOKED" },
    )
    await fixture.finishJob(revokedJob, { outcome: "cancelled" })
    assert.equal(extractorCalls, 0)
    const budgetExtractor = async (input: { onBeforeCall: (reservation: { callNumber: number }) => Promise<void> }) => {
      await input.onBeforeCall({ callNumber: 1 })
      return { candidates: [] }
    }
    const outcome = await executeRequirements(fixture, await fixture.submitRequirementsTask(), { extractor: budgetExtractor }, {
      reserveCall: async () => { throw Object.assign(new Error("预算不足"), { code: "BUDGET_EXHAUSTED" }) },
    })
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "BUDGET_EXHAUSTED")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("bid-requirements executor: oversized tender text fails before any model call instead of truncating", async () => {
  const fixture = await setupVerification()
  try {
    const long = await fixture.addMaterial(["字".repeat(61_000)], { title: "超长招标文件" })
    const job = await fixture.submitRequirementsTask({
      materials: [{ materialVersionId: long.versionId, sha256: long.sha256 }],
    })
    let fetcherCalls = 0
    const extractor = createBidRequirementExtractor({
      fetcher: async () => { fetcherCalls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{\"candidates\":[]}" } }] }) },
    })
    const outcome = await executeRequirements(fixture, job, {
      extractor,
      env: { AI_API_KEY: "synthetic", AI_BASE_URL: "https://gateway.invalid/v1", AI_MODEL: "synthetic-model" },
    })
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "EXTRACTOR_FAILED")
    assert.equal(fetcherCalls, 0)
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("bid-requirements executor: partial parse coverage is surfaced as a fixed warning on the candidate value", async () => {
  const fixture = await setupVerification()
  try {
    const coverage: ParseCoverage = { status: "partial", findings: [{ code: "embedded_image", location: "图片 1 处" }], pageCount: null, textLength: 20 }
    const partialMaterial = await fixture.addMaterial(["投标人应具有有效的安全生产许可证。"], { title: "部分解析招标文件", coverage })
    const job = await fixture.submitRequirementsTask({
      materials: [{ materialVersionId: partialMaterial.versionId, sha256: partialMaterial.sha256 }],
    })
    const extractor = async () => ({
      candidates: [{
        subject: "华建机电安装有限公司", quote: partialMaterial.fragments[0].text, nature: "资格否决",
        field: "certificate_kind", operator: "eq", value: "安全生产许可证",
        asOfRule: "task_as_of", materialRelation: "安全生产许可证",
      }],
    })
    const outcome = await executeRequirements(fixture, job, { extractor })
    assert.equal(outcome.outcome, "success")
    const views = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-requirements")
    assert.equal(views.length, 1)
    const value = views[0].value as { status: string; warnings: string[] }
    assert.equal(value.status, "candidate")
    assert.ok(value.warnings.includes(PARTIAL_COVERAGE_WARNING))
    assert.match(PARTIAL_COVERAGE_WARNING, /解析覆盖限制/)
    assert.match(PARTIAL_COVERAGE_WARNING, /不能视为全面资格要求检查/)
    // The machine candidate stays partial: no full-review claim is possible.
    assert.equal(views[0].validation.status, "partial")
  } finally { await fixture.close() }
})

test("bid-requirements executor: retention is re-checked before every model call", async () => {
  const fixture = await setupVerification()
  try {
    const job = await fixture.submitRequirementsTask()
    const extractor = async (input: { onBeforeCall: (reservation: { callNumber: number }) => Promise<void> }) => {
      await input.onBeforeCall({ callNumber: 1 })
      // The first material expires between the two paid calls.
      await fixture.database.transaction(async connection => {
        await connection.query("UPDATE equilens_materials SET retention_until='2020-01-01' WHERE id=$1", [fixture.materials[0].materialId])
      })
      await input.onBeforeCall({ callNumber: 2 })
      return { candidates: [] }
    }
    const outcome = await executeRequirements(fixture, job, { extractor })
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RETENTION_EXPIRED")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})
