import assert from "node:assert/strict"
import { test } from "node:test"
import type { BidVerificationValue } from "../../lib/business/verification-types"
import { createBidVerificationExecutor } from "./executor"
import {
  executorContext, projectId, setupVerification, testAuthorizer, testIdentity,
  type VerificationFixture,
} from "./verification-test-fixtures"

/**
 * C4-VERIFY service contract (spec 01 §8.2.3, plan §4.7/§5).
 *
 * `saveRequirementSet` is the only requirement-set write path and re-reads every
 * cited version/snapshot/fragment; forged or mismatched quotes are rejected.
 * External records are append-only evidence: appending never rewrites a saved
 * result, and the detail/list hint reports that records/fields changed.
 */
const recordInput = (overrides: Partial<Parameters<VerificationFixture["service"]["recordExternalVerification"]>[2]> = {}) => ({
  projectId,
  resultId: "",
  versionId: "",
  sha256: "",
  requirementId: "req-1",
  subject: "华建机电安装有限公司",
  certificateNo: "91310000MA1FL0XX2A",
  source: "全国建筑市场监管公共服务平台",
  queriedAt: "2026-10-29T00:00:00.000Z",
  queryConditions: "按统一社会信用代码查询",
  conclusion: "matched",
  proofMaterialVersionId: "",
  ...overrides,
})

async function prepared() {
  const fixture = await setupVerification()
  const tender = fixture.materials[0]
  const certificate = fixture.materials[1]
  fixture.addFields(certificate, [
    { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
    { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
  ])
  const requirementSet = await fixture.saveRequirementSet()
  const job = await fixture.submitVerificationTask({
    requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
    materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
  })
  const outcome = await createBidVerificationExecutor(fixture.executorDependencies())(job, executorContext())
  assert.equal(outcome.outcome, "success")
  await fixture.finishJob(job, outcome)
  const summary = JSON.parse(String(outcome.resultSummary)) as { resultId: string; versionId: string; sha256: string }
  return { fixture, tender, certificate, requirementSet, verification: summary }
}

test("service: saveRequirementSet re-reads fragments and saves a server-owned human version", async () => {
  const fixture = await setupVerification()
  try {
    const tender = fixture.materials[0]
    const saved = await fixture.saveRequirementSet()
    assert.equal(saved.kind, "bid-requirements")
    assert.equal(saved.origin, "human")
    assert.equal(saved.validation.status, "valid")
    assert.ok(saved.sources.length >= 1)
    assert.equal(saved.sources[0].snapshotId, tender.snapshotId)
    assert.equal(saved.sources[0].quote, tender.fragments[0].text)
    assert.deepEqual(saved.dependencies, [{ kind: "material", id: tender.materialId, versionId: tender.versionId }])
    // Same operation id + same input is idempotent; a new version requires the current base.
    assert.equal((await fixture.saveRequirementSet({ operationId: "idempotent" })).versionId,
      (await fixture.saveRequirementSet({ operationId: "idempotent" })).versionId)
    const second = await fixture.saveRequirementSet({
      resultId: saved.resultId, baseVersionId: saved.versionId, operationId: "second-version",
      value: { ...fixture.requirementSetValue(), warnings: ["人工确认备注"] },
    })
    assert.notEqual(second.versionId, saved.versionId)
    assert.deepEqual((await fixture.results.get(testIdentity, testAuthorizer, projectId, saved.resultId, saved.versionId)).value, fixture.requirementSetValue())
    // A stale base version is a conflict.
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, resultId: saved.resultId, baseVersionId: saved.versionId, operationId: "stale", reason: "过期基础版本", value: fixture.requirementSetValue(),
    }), { code: "CONFLICT" })
    // Viewers cannot save requirement sets.
    const viewer = async (_identity: unknown, target: string, action: "read" | "edit" | "manage") =>
      ({ projectId: target, action, role: "viewer" as const, identity: testIdentity })
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, viewer, {
      projectId, baseVersionId: "", operationId: "viewer", reason: "只读", value: fixture.requirementSetValue(),
    }), { code: "FORBIDDEN" })
    // The generic browser result save path cannot write requirement sets; the
    // server-owned VerificationService path above is the only writer.
    await assert.rejects(fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "bid-requirements", baseVersionId: "", operationId: "browser-write", reason: "普通成果写入",
      value: fixture.requirementSetValue(), sources: [], dependencies: [],
    }), { code: "FORBIDDEN" })
  } finally { await fixture.close() }
})

test("service: forged, mismatched, cross-project or inactive requirement sources are rejected without saving", async () => {
  const fixture = await setupVerification()
  try {
    const tender = fixture.materials[0]
    const other = fixture.materials[1]
    const forgedQuote = { ...fixture.requirementSetValue(), requirements: [{ ...fixture.requirementSetValue().requirements[0], quote: "伪造的原文引文" }] }
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "forged", reason: "伪造引文", value: forgedQuote,
    }), { code: "INVALID_INPUT" })

    const mismatchedSource = fixture.requirementSetValue(tender)
    mismatchedSource.requirements[0] = { ...mismatchedSource.requirements[0], source: { snapshotId: other.snapshotId, fragmentId: other.fragments[0].id } }
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "wrong-snapshot", reason: "快照失配", value: mismatchedSource,
    }), { code: "INVALID_INPUT" })

    const foreignVersion = fixture.requirementSetValue(tender)
    foreignVersion.requirements[0] = { ...foreignVersion.requirements[0], materialVersionId: "foreign-version" }
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "foreign", reason: "跨项目版本", value: foreignVersion,
    }), { code: "INVALID_INPUT" })

    await fixture.database.transaction(async connection => {
      await connection.query("UPDATE equilens_materials SET status='deleted' WHERE id=$1", [tender.materialId])
    })
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "inactive", reason: "材料已删除", value: fixture.requirementSetValue(tender),
    }), { code: "INVALID_INPUT" })
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-requirements").length, 0)
  } finally { await fixture.close() }
})

test("service: external records append once, stay project-scoped and never rewrite the saved result", async () => {
  const { fixture, certificate, verification } = await prepared()
  try {
    const input = recordInput({
      resultId: verification.resultId, versionId: verification.versionId, sha256: verification.sha256,
      proofMaterialVersionId: certificate.versionId,
    })
    const appended = await fixture.service.recordExternalVerification(testIdentity, testAuthorizer, input)
    assert.equal(appended.conclusion, "matched")
    assert.equal(appended.requirementSetVersionId.length > 0, true)
    assert.match(appended.sha256, /^[a-f0-9]{64}$/)
    // Identical evidence is idempotent instead of duplicated.
    const duplicate = await fixture.service.recordExternalVerification(testIdentity, testAuthorizer, input)
    assert.equal(duplicate.recordId, appended.recordId)
    const detail = await fixture.service.get(testIdentity, testAuthorizer, projectId, verification.resultId)
    assert.equal(detail.records.length, 1)
    assert.equal(detail.records[0].recordId, appended.recordId)
    // The saved comparison value is unchanged and the honest hint appears.
    assert.equal((detail.result.value as BidVerificationValue).items[0].externalCheck, "未核验")
    assert.equal(detail.stale.records, true)
    assert.equal(detail.stale.hint !== null, true)
    const list = await fixture.service.list(testIdentity, testAuthorizer, projectId)
    const item = list.find(entry => entry.resultId === verification.resultId)
    assert.ok(item)
    assert.equal(item.stale.records, true)
    assert.match(String(item.stale.hint), /重新运行/)
  } finally { await fixture.close() }
})

test("service: external record validation rejects unknown requirements, stale digests and invalid proof materials", async () => {
  const { fixture, certificate, verification } = await prepared()
  try {
    const base = recordInput({
      resultId: verification.resultId, versionId: verification.versionId, sha256: verification.sha256,
      proofMaterialVersionId: certificate.versionId,
    })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, requirementId: "req-unknown" }), { code: "INVALID_INPUT" })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, sha256: "f".repeat(64) }), { code: "CONFLICT" })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, proofMaterialVersionId: "foreign-version" }), { code: "INVALID_INPUT" })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, conclusion: "passed" }), { code: "INVALID_INPUT" })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, source: "" }), { code: "INVALID_INPUT" })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, { ...base, queriedAt: "not-a-time" }), { code: "INVALID_INPUT" })
    await fixture.database.transaction(async connection => {
      await connection.query("UPDATE equilens_materials SET status='deleted' WHERE id=$1", [certificate.materialId])
    })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, testAuthorizer, base), { code: "INVALID_INPUT" })
    // Viewers can read but cannot append evidence.
    const viewer = async (_identity: unknown, target: string, action: "read" | "edit" | "manage") =>
      ({ projectId: target, action, role: "viewer" as const, identity: testIdentity })
    await assert.rejects(fixture.service.recordExternalVerification(testIdentity, viewer, base), { code: "FORBIDDEN" })
    assert.equal((await fixture.service.get(testIdentity, testAuthorizer, projectId, verification.resultId)).records.length, 0)
  } finally { await fixture.close() }
})

test("service: field changes after a saved comparison produce the 需重新运行 hint", async () => {
  const { fixture, certificate, verification } = await prepared()
  try {
    const before = await fixture.service.get(testIdentity, testAuthorizer, projectId, verification.resultId)
    assert.equal(before.stale.fields, false)
    assert.equal(before.stale.hint, null)
    fixture.removeFields(certificate, "subject_name")
    fixture.addFields(certificate, [{ fieldKey: "subject_name", valueText: "海联机电安装有限公司", origin: "manual" }])
    const after = await fixture.service.get(testIdentity, testAuthorizer, projectId, verification.resultId)
    assert.equal(after.stale.fields, true)
    assert.match(String(after.stale.hint), /重新运行/)
    // The saved value itself keeps the old evidence.
    assert.equal((after.result.value as BidVerificationValue).items[0].evidence.some(entry => entry.valueText === "海联机电安装有限公司"), false)
  } finally { await fixture.close() }
})

test("service: list/get expose only the two C4 kinds and hide unrelated results with the same project", async () => {
  const { fixture, verification } = await prepared()
  try {
    const other = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "test-result", baseVersionId: "", operationId: "unrelated", reason: "其他成果",
      value: { text: "other" }, sources: [], dependencies: [],
    })
    const list = await fixture.service.list(testIdentity, testAuthorizer, projectId)
    assert.ok(list.every(entry => entry.kind === "bid-requirements" || entry.kind === "bid-verification"))
    assert.ok(list.some(entry => entry.resultId === verification.resultId))
    await assert.rejects(fixture.service.get(testIdentity, testAuthorizer, projectId, other.resultId), { code: "NOT_FOUND" })
    // Unknown result and cross-project ids are the same uniform not-found (404 contract).
    await assert.rejects(fixture.service.get(testIdentity, testAuthorizer, projectId, "unknown-result"), { code: "NOT_FOUND" })
    await assert.rejects(fixture.service.get(testIdentity, testAuthorizer, "other-project", verification.resultId), { code: "NOT_FOUND" })
  } finally { await fixture.close() }
})

test("service: read-only members can read the verification list and detail", async () => {
  const { fixture, verification } = await prepared()
  try {
    const viewer = async (_identity: unknown, target: string, action: "read" | "edit" | "manage") =>
      ({ projectId: target, action, role: "viewer" as const, identity: testIdentity })
    assert.ok((await fixture.service.list(testIdentity, viewer, projectId)).length >= 1)
    const detail = await fixture.service.get(testIdentity, viewer, projectId, verification.resultId)
    assert.equal(detail.result.resultId, verification.resultId)
    assert.equal(detail.result.kind, "bid-verification")
  } finally {
    await fixture.close()
  }
})

test("service: server-owned requirement save caps the requirement count and raw value size", async () => {
  const fixture = await setupVerification()
  try {
    const base = fixture.requirementSetValue()
    const build = (count: number) => ({
      ...base,
      requirements: Array.from({ length: count }, (_, index) => ({ ...base.requirements[0], requirementId: `req-${index}` })),
    })
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "too-many", reason: "超量要求", value: build(201),
    }), { code: "INVALID_INPUT" })
    await assert.rejects(fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "too-large", reason: "超大要求集",
      value: { ...base, warnings: ["x".repeat(210_000)] },
    }), { code: "INVALID_INPUT" })
    // The boundary (200 requirements) is still saveable.
    const saved = await fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
      projectId, baseVersionId: "", operationId: "max-200", reason: "边界要求集", value: build(200),
    })
    assert.equal((saved.value as { requirements: unknown[] }).requirements.length, 200)
    assert.equal(saved.validation.status, "valid")
  } finally { await fixture.close() }
})
