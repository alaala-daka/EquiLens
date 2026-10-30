import assert from "node:assert/strict"
import { test } from "node:test"
import type { BidVerificationValue } from "../../lib/business/verification-types"
import { createBidVerificationExecutor } from "./executor"
import { OcrRepository } from "./ocr-repository"
import {
  accountId, executorContext, projectId, setupVerification, testAuthorizer, testIdentity,
} from "./verification-test-fixtures"

/**
 * Cross-package integration: C4-OCR `OcrRepository` (real migration-0010 field
 * store) → C4-VERIFY deterministic comparison (plan §4.6/§5 `field-integration`).
 *
 * Proves that B consumes A's frozen `FieldSource`: current-only values, OCR
 * original vs manual correction history, and one field source object driving the
 * comparison evidence/status without C4-VERIFY touching the field tables.
 */
async function writeOcrFields(repository: OcrRepository, material: { materialId: string; versionId: string; snapshotId: string; fragments: Array<{ id: string }> }, values: Array<{ fieldKey: string; valueText: string }>) {
  const run = await repository.beginRun({
    projectId, materialId: material.materialId, versionId: material.versionId,
    certificateKind: "营业执照", createdBy: accountId,
  })
  await repository.completeRun({
    projectId, id: run.id, state: "succeeded", callsUsed: 1, provider: "synthetic-test", finishedAt: "2026-10-29T00:00:00.000Z",
    fields: values.map((value, index) => ({
      projectId, materialId: material.materialId, versionId: material.versionId, subjectKey: "enterprise",
      fieldKey: value.fieldKey as never, valueText: value.valueText, origin: "ocr" as const,
      sourceSnapshotId: material.snapshotId, sourceFragmentId: material.fragments[0]?.id ?? null,
      ocrRunId: run.id, confidence: 90, createdBy: accountId, idempotencyKey: `ocr-field-${index}`,
    })),
  })
  return run.id
}

async function prepared() {
  const fixture = await setupVerification()
  const tender = fixture.materials[0]
  const certificate = fixture.materials[1]
  const requirementSet = await fixture.saveRequirementSet()
  return { fixture, tender, certificate, requirementSet }
}

test("field integration: C4-OCR repository → comparison uses only current OCR values", async () => {
  const { fixture, certificate, requirementSet } = await prepared()
  const ocr = new OcrRepository(fixture.database, () => new Date("2026-10-29T00:00:00.000Z"))
  try {
    await writeOcrFields(ocr, certificate, [
      { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
      { fieldKey: "certificate_kind", valueText: "营业执照" },
    ])
    const fieldValues = await ocr.values(projectId, [certificate.versionId])
    assert.equal(fieldValues.length, 3)
    assert.ok(fieldValues.every(value => value.origin === "ocr" && value.confidence === 90))
    // Cross-project/cross-material reads stay empty.
    assert.deepEqual(await ocr.values("other-project", [certificate.versionId]), [])
    assert.deepEqual(await ocr.values(projectId, ["other-version"]), [])
    const job = await fixture.submitVerificationTask({
      requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
      materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
    })
    const outcome = await createBidVerificationExecutor(fixture.executorDependencies({ fieldSource: ocr }))(job, executorContext())
    assert.equal(outcome.outcome, "success")
    await fixture.finishJob(job, outcome)
    const view = await fixture.results.get(testIdentity, testAuthorizer, projectId, (JSON.parse(String(outcome.resultSummary)) as { resultId: string }).resultId)
    const value = view.value as BidVerificationValue
    assert.equal(view.validation.status, "valid")
    assert.equal(value.items[0].materialCheck, "满足材料要求")
    const evidence = value.items[0].evidence.find(entry => entry.fieldKey === "subject_name")
    assert.ok(evidence)
    assert.equal(evidence.valueText, "华建机电安装有限公司")
    assert.equal(evidence.origin, "ocr")
    assert.equal(evidence.subjectKey, "enterprise")
  } finally { await fixture.close() }
})

test("field integration: unsupported human corrections stay pending while OCR originals stay in history", async () => {
  const { fixture, certificate, requirementSet } = await prepared()
  const ocr = new OcrRepository(fixture.database, () => new Date("2026-10-29T00:00:00.000Z"))
  try {
    await writeOcrFields(ocr, certificate, [
      { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
    ])
    await ocr.insertFields([{
      projectId, materialId: certificate.materialId, versionId: certificate.versionId, subjectKey: "enterprise",
      fieldKey: "subject_name", valueText: "海联机电安装有限公司", origin: "manual",
      sourceSnapshotId: null, sourceFragmentId: null,
      reason: "人工核对营业执照原件后更正", createdBy: accountId, idempotencyKey: "manual-correction-1",
    }])
    const current = await ocr.values(projectId, [certificate.versionId])
    const subject = current.filter(value => value.fieldKey === "subject_name")
    assert.equal(subject.length, 1)
    assert.equal(subject[0].valueText, "海联机电安装有限公司")
    assert.equal(subject[0].origin, "manual")
    assert.equal(subject[0].revision, 2)
    const history = await ocr.fieldHistory(projectId, certificate.versionId)
    const subjectHistory = history.filter(record => record.fieldKey === "subject_name")
    assert.equal(subjectHistory.length, 2)
    assert.ok(subjectHistory.some(record => record.valueText === "华建机电安装有限公司"))
    assert.ok(subjectHistory.some(record => record.supersededAt !== null))
    // The correction has no verified material origin and cannot establish a pass or a hard conflict.
    const job = await fixture.submitVerificationTask({
      requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
      materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
    })
    const outcome = await createBidVerificationExecutor(fixture.executorDependencies({ fieldSource: ocr }))(job, executorContext())
    assert.equal(outcome.outcome, "partial")
    await fixture.finishJob(job, outcome)
    const view = await fixture.results.get(testIdentity, testAuthorizer, projectId, (JSON.parse(String(outcome.resultSummary)) as { resultId: string }).resultId)
    const value = view.value as BidVerificationValue
    assert.equal(value.items[0].materialCheck, "待确认")
    const evidence = value.items[0].evidence.find(entry => entry.fieldKey === "subject_name")
    assert.ok(evidence)
    assert.equal(evidence.origin, "manual")
    assert.equal(evidence.valueText, "海联机电安装有限公司")
  } finally { await fixture.close() }
})
