import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { unzipSync, strFromU8 } from "fflate"
import type { BidVerificationValue } from "../../lib/business/verification-types"
import { ExportRepository } from "../exports/repository"
import { ExportService, ExportTemplateRegistry } from "../exports/service"
import { createBidVerificationExecutor } from "./executor"
import { bidVerificationReportTemplate } from "./export-template"
import {
  accountId, executorContext, projectId, setupVerification, testAuthorizer, testIdentity,
  type VerificationFixture,
} from "./verification-test-fixtures"

/**
 * C4-VERIFY no-external-service closed loop (plan §5/§6 acceptance).
 *
 * Synthetic project → server-owned requirement-set save → manual text-material
 * fields (fake FieldSource) → `bid-verification` task → executor writes a new
 * machine result → validate → review approve → versioned Word export → download
 * digest. Negative branches: missing material stays a determinate 材料缺失 status;
 * a partial comparison is a draft export; an invalid machine result is saved for
 * audit but the task fails and export is blocked.
 *
 * This test does not need real OCR/MaaS/OBS/database services; the production
 * registrations (results/registry, exports/template, instrumentation) are the
 * Lead's integration step and are asserted by the integration round.
 */
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function exportService(fixture: VerificationFixture): ExportService {
  const templates = new ExportTemplateRegistry(new Map([["bid-verification", bidVerificationReportTemplate]]))
  const retention = async (ref: { projectId: string; resultId: string; versionId: string; sha256: string }) =>
    fixture.database.transaction(async connection => {
      const project = (await connection.query("SELECT retention_until FROM equilens_projects WHERE id=$1 AND status='active'", [ref.projectId])).rows[0]
      const version = (await connection.query("SELECT sources_json FROM equilens_result_versions WHERE project_id=$1 AND result_id=$2 AND id=$3 AND sha256=$4", [ref.projectId, ref.resultId, ref.versionId, ref.sha256])).rows[0]
      if (!project || !version) return null
      const deadlines = [Date.parse(String(project.retention_until))]
      for (const source of JSON.parse(String(version.sources_json)) as Array<{ snapshotId: string }>) {
        const material = (await connection.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_parse_snapshots s ON s.material_id=m.id AND s.project_id=m.project_id WHERE s.project_id=$1 AND s.id=$2 AND m.status='active'", [ref.projectId, source.snapshotId])).rows[0]
        if (!material) return null
        deadlines.push(Date.parse(String(material.retention_until)))
      }
      const dependencies = (await connection.query("SELECT dependency_version_id FROM equilens_result_dependencies WHERE project_id=$1 AND result_id=$2 AND version_id=$3 AND dependency_kind='material'", [ref.projectId, ref.resultId, ref.versionId])).rows
      for (const dependency of dependencies) {
        const material = (await connection.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_material_versions v ON v.material_id=m.id AND v.project_id=m.project_id WHERE m.project_id=$1 AND v.id=$2 AND m.status='active'", [ref.projectId, String(dependency.dependency_version_id)])).rows[0]
        if (!material) return null
        deadlines.push(Date.parse(String(material.retention_until)))
      }
      return deadlines.every(Number.isFinite) ? new Date(Math.min(...deadlines)).toISOString() : null
    })
  return new ExportService(new ExportRepository(fixture.database), fixture.results, fixture.store, templates, retention)
}

async function runTask(
  fixture: VerificationFixture,
  job: Awaited<ReturnType<VerificationFixture["submitVerificationTask"]>>,
  dependencies: Parameters<typeof fixture.executorDependencies>[0] = {},
) {
  const outcome = await createBidVerificationExecutor(fixture.executorDependencies(dependencies))(job, executorContext())
  await fixture.finishJob(job, outcome)
  return outcome
}

async function preparedLoop() {
  const fixture = await setupVerification({ fragments: ["投标人应具有有效的营业执照，并具备安全生产许可证。", "华建机电安装有限公司的安全生产许可证有效期不得早于2027-12-31。"] })
  const tender = fixture.materials[0]
  const certificate = fixture.materials[1]
  fixture.addFields(certificate, [
    { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
    { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
    { fieldKey: "certificate_kind", valueText: "安全生产许可证" },
    { fieldKey: "expiry_date", valueText: "2028-12-31" },
  ])
  const base = fixture.requirementSetValue(tender)
  const secondRequirement = {
    ...base.requirements[0],
    requirementId: "req-2",
    quote: tender.fragments[1].text,
    source: { snapshotId: tender.snapshotId, fragmentId: tender.fragments[1].id },
    subject: "华建机电安装有限公司",
    field: "expiry_date" as const,
    operator: "on_or_after" as const,
    value: "2027-12-31",
    nature: "一般提交" as const,
    materialRelation: "安全生产许可证有效期",
  }
  const requirementSet = await fixture.saveRequirementSet({
    value: { ...base, requirements: [...base.requirements, secondRequirement] },
    operationId: "closed-loop-set",
  })
  const materialRef = { materialVersionId: certificate.versionId, sha256: certificate.sha256 }
  const setRef = { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 }
  return { fixture, tender, certificate, requirementSet, materialRef, setRef }
}

test("closed loop: requirement set save → deterministic task → validate → approve → export → download digest", async () => {
  const { fixture, certificate, materialRef, setRef } = await preparedLoop()
  try {
    const job = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    const outcome = await runTask(fixture, job)
    // The unified runner's terminal state is success; the executor wrote exactly one result.
    assert.equal(outcome.outcome, "success")
    assert.equal((await fixture.tasks.get(accountId, job.id)).state, "success")
    const views = (await fixture.results.list(testIdentity, testAuthorizer, projectId)).filter(view => view.kind === "bid-verification")
    assert.equal(views.length, 1)
    const result = views[0]
    assert.equal(result.validation.status, "valid")
    const value = result.value as BidVerificationValue
    assert.equal(value.status, "success")
    assert.equal(value.items.length, 2)
    assert.ok(value.items.every(item => item.materialCheck === "满足材料要求"))
    assert.ok(value.items.every(item => item.externalCheck === "未核验"))
    assert.equal(value.unfinished.length, 2)

    // Validation re-read is deterministic and the version can be approved.
    const revalidated = await fixture.results.validateResult(testIdentity, testAuthorizer, {
      projectId, resultId: result.resultId, versionId: result.versionId, sha256: result.sha256,
    })
    assert.equal(revalidated.status, "valid")
    const approved = await fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: result.resultId, versionId: result.versionId, sha256: result.sha256,
      decision: "approved", comment: "材料一致性结论已复核",
    })
    assert.equal(approved.review?.decision, "approved")

    // Versioned Word export reads only the saved value and downloads with a verified digest.
    const exports = exportService(fixture)
    const exportRef = await exports.createExport(testIdentity, testAuthorizer, {
      projectId, resultId: result.resultId, versionId: result.versionId, sha256: result.sha256,
    })
    assert.equal(exportRef.format, "docx")
    const bytes = await exports.download(testIdentity, testAuthorizer, projectId, result.resultId, exportRef.exportId)
    const stored = await fixture.database.transaction(async connection =>
      (await connection.query("SELECT sha256 FROM equilens_result_exports WHERE project_id=$1 AND id=$2", [projectId, exportRef.exportId])).rows[0])
    assert.ok(stored)
    assert.equal(digest(bytes), String(stored.sha256))
    const document = strFromU8(unzipSync(bytes)["word/document.xml"])
    assert.match(document, /投标材料核验报告/)
    assert.match(document, /材料检查：满足材料要求/)
    assert.match(document, /外部真实性：未核验/)
    assert.match(document, /bid-verification-report-v1/)
    assert.match(document, /已复核/)
    assert.match(document, /不代表投标人资格真实或材料齐全/)
    // The export snapshot pins the result version; the result was not regenerated.
    const listed = await exports.list(testIdentity, testAuthorizer, projectId, result.resultId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].versionId, result.versionId)
    assert.ok(certificate.sha256.length === 64)
  } finally { await fixture.close() }
})

test("closed loop negative: missing material stays 材料缺失 (not a pass) and partial results export as drafts", async () => {
  const { fixture, tender, certificate, materialRef, setRef } = await preparedLoop()
  try {
    // Remove the certificate fields: the material check must report 材料缺失, never satisfied.
    fixture.removeFields(certificate, "certificate_kind")
    fixture.removeFields(certificate, "expiry_date")
    const missingJob = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    const missing = await runTask(fixture, missingJob)
    assert.equal(missing.outcome, "success")
    const missingView = await fixture.results.get(testIdentity, testAuthorizer, projectId, (JSON.parse(String(missing.resultSummary)) as { resultId: string }).resultId)
    const missingValue = missingView.value as BidVerificationValue
    assert.equal(missingValue.status, "success")
    assert.equal(missingValue.items.find(item => item.requirementId === "req-1")?.materialCheck, "满足材料要求")
    assert.equal(missingValue.items.find(item => item.requirementId === "req-2")?.materialCheck, "材料缺失")
    assert.equal(missingValue.coverage.materialMissing, 1)
    assert.equal(missingValue.coverage.materialSatisfied, 1)

    // A conflicting addendum is 待确认 → partial; validation stays partial and approval is refused.
    const conflictValue = {
      ...fixture.requirementSetValue(tender),
      requirements: [{ ...fixture.requirementSetValue(tender).requirements[0], addendum: { state: "conflict" as const, note: "招标文件与补遗冲突" } }],
    }
    const conflictSet = await fixture.saveRequirementSet({ value: conflictValue, operationId: "closed-loop-conflict" })
    const partialJob = await fixture.submitVerificationTask({
      requirementSet: { id: conflictSet.resultId, versionId: conflictSet.versionId, sha256: conflictSet.sha256 },
      materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
    })
    const partialOutcome = await runTask(fixture, partialJob)
    assert.equal(partialOutcome.outcome, "partial")
    const partialView = await fixture.results.get(testIdentity, testAuthorizer, projectId, (JSON.parse(String(partialOutcome.resultSummary)) as { resultId: string }).resultId)
    assert.equal(partialView.validation.status, "partial")
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: partialView.resultId, versionId: partialView.versionId, sha256: partialView.sha256,
      decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
    // Partial results may still be exported, marked as a draft snapshot.
    const exportRef = await exportService(fixture).createExport(testIdentity, testAuthorizer, {
      projectId, resultId: partialView.resultId, versionId: partialView.versionId, sha256: partialView.sha256,
    })
    const snapshot = await fixture.database.transaction(async connection =>
      (await connection.query("SELECT snapshot_json FROM equilens_result_exports WHERE project_id=$1 AND id=$2", [projectId, exportRef.exportId])).rows[0])
    const parsed = JSON.parse(String(snapshot.snapshot_json)) as { metadata: string[] }
    assert.ok(parsed.metadata.some(line => line.includes("草稿")))
    assert.ok(parsed.metadata.some(line => line.includes("校验：partial")))
  } finally { await fixture.close() }
})

test("closed loop negative: an audit-saved invalid machine result fails the task and blocks export", async () => {
  const { fixture, certificate, materialRef, setRef } = await preparedLoop()
  try {
    const validJob = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    const validOutcome = await runTask(fixture, validJob)
    assert.equal(validOutcome.outcome, "success")
    const baseline = JSON.parse(String(validOutcome.resultSummary)) as { resultId: string; versionId: string; sha256: string }
    const baselineView = await fixture.results.get(testIdentity, testAuthorizer, projectId, baseline.resultId)
    const tampered = JSON.parse(JSON.stringify(baselineView.value)) as BidVerificationValue
    // Claim an external match that no pinned record supports: record integrity violation.
    tampered.items[0].externalCheck = "人工查询记录匹配"
    // Save it as the machine output of another claimed task (audit path), then fail the task.
    const job = await fixture.submitVerificationTask({ requirementSet: setRef, materials: [materialRef] })
    const saved = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "bid-verification", baseVersionId: "", operationId: `audit:${job.id}:${job.attempt}`,
      reason: "审计用无效机器成果", value: tampered, sources: [], dependencies: [],
    }, { output: tampered, taskId: job.id, attempt: job.attempt, executionToken: job.token })
    await fixture.finishJob(job, { outcome: "failed", errorCode: "RESULT_INVALID" })
    assert.equal(saved.validation.status, "invalid")
    assert.equal((await fixture.tasks.get("22222222-2222-4222-8222-222222222222", job.id)).state, "failed")
    await assert.rejects(exportService(fixture).createExport(testIdentity, testAuthorizer, {
      projectId, resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256,
    }), { code: "INVALID_SOURCE" })
    assert.ok(certificate.versionId.length > 0)
  } finally { await fixture.close() }
})
