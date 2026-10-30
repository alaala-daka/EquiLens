import assert from "node:assert/strict"
import test from "node:test"
import type { SnapshotFragment } from "../../../lib/business/materials-client"
import type {
  BidVerificationValue, RequirementSetValue, VerificationListSummary, VerificationRequirement,
} from "../../../lib/business/verification-types"
import type { VerificationMaterial, VerificationTaskView } from "../../../lib/business/verifications-client"
import {
  activeTask, bidVerificationValue, buildComparisonSubmission, buildRequirementsSubmission, checkRequirementItem,
  checkRequirementSet, comparisonReadiness, comparisonRequirementSetOptions, couldExport, coverageSummaryLabel,
  emptyRequirementSet, evidenceMaterial, externalStatusIsPass, fieldFormFromView, fieldLabel, filterFragments,
  findEquivalentActiveTask, finishedTasks, formatTaskElapsed, fragmentLocationLabel, fragmentPreview, materialTitle,
  materialUnavailableReason, materialVersionRefs, mergeTaskRows, newManualRequirement, nextSubmissionOperation,
  normalizeQueriedAt, operatorLabels, parseTaskResultReference, preparedRequirementSet, quoteMatchesFragment,
  recordFormFromRequirement, rejectRequirement, requirementExpressionLabel, requirementSetCounts, requirementSetStatusLabel,
  requirementSetValue, requirementSourceMaterial, shouldPollVerificationTasks, snapshotReadable, staleHint, submissionInputSignature,
  taskInputSignature, taskStageLabel, taskStateLabel, updateRejectedReason, updateRequirement, validateExternalRecordForm,
  validateFieldForm, verificationItemRows, verificationListItems, verificationTasksOnly,
} from "./verification-state"

const hash = "a".repeat(64)

function material(overrides: Partial<VerificationMaterial> = {}): VerificationMaterial {
  return {
    id: "material-1",
    title: "招标文件",
    fileName: null,
    format: "docx",
    versionId: "version-1",
    sha256: hash,
    parseTaskId: "parse-task-1",
    parseState: "success",
    snapshotId: "snapshot-1",
    coverage: { status: "available", textLength: 600, pageCount: 2, findings: [] },
    size: 1000,
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  }
}

function fragment(overrides: Partial<SnapshotFragment> = {}): SnapshotFragment {
  return {
    id: "fragment-1",
    kind: "paragraph",
    order: 0,
    page: 0,
    paragraph: 4,
    headingPath: ["投标人资格要求"],
    tableIndex: null,
    row: null,
    column: null,
    text: "投标人须具备建筑工程施工总承包一级资质，证书编号须与营业执照一致。",
    ...overrides,
  }
}

function requirement(overrides: Partial<VerificationRequirement> = {}): VerificationRequirement {
  return {
    requirementId: "REQ-1",
    subject: "投标人",
    quote: "建筑工程施工总承包一级资质",
    materialVersionId: "version-1",
    source: { snapshotId: "snapshot-1", fragmentId: "fragment-1" },
    addendum: { state: "none", note: "" },
    nature: "资格否决",
    field: "certificate_level",
    operator: "contains",
    value: "一级",
    asOfRule: "not_applicable",
    materialRelation: "企业资质证书",
    group: null,
    status: "confirmed",
    statusNote: "",
    ...overrides,
  }
}

function setValue(overrides: Partial<RequirementSetValue> = {}): RequirementSetValue {
  return { schemaVersion: 1, status: "confirmed", requirements: [requirement()], rejected: [], warnings: [], errors: [], ...overrides }
}

function task(kind: "bid-requirements" | "bid-verification", state: VerificationTaskView["state"] = "queued", overrides: Partial<VerificationTaskView> = {}): VerificationTaskView {
  return {
    id: "task-1",
    kind,
    projectId: "project-1",
    state,
    stage: state === "running" ? "claimed" : state,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    callsUsed: 0,
    maxCalls: kind === "bid-requirements" ? 2 : 0,
    elapsedMs: 5000,
    manifest: {
      version: 1, catalogVersion: 4, kind, projectId: "project-1",
      refs: { materials: [{ materialVersionId: "version-1", sha256: hash }] },
      conditions: kind === "bid-requirements" ? { externalProcessingConsent: true } : { asOf: "2026-10-29" },
      submittedBy: "account-1", submittedAt: "2026-10-29T00:00:00.000Z",
    },
    error: null,
    resultSummary: null,
    ...overrides,
  }
}

function comparisonValue(overrides: Partial<BidVerificationValue> = {}): BidVerificationValue {
  return {
    schemaVersion: 1,
    status: "success",
    asOf: "2026-10-29",
    requirementSet: {
      id: "set-1", versionId: "set-version-1", sha256: "d".repeat(64),
      requirements: [{
        requirementId: "REQ-1", subject: "投标人", quote: "建筑工程施工总承包一级资质",
        source: { snapshotId: "snapshot-1", fragmentId: "fragment-1" }, materialVersionId: "version-1",
        nature: "资格否决", field: "certificate_level", operator: "contains", value: "一级",
        asOfRule: "not_applicable", addendumState: "none", materialRelation: "企业资质证书", group: null,
      }],
    },
    materials: [{ materialId: "material-1", versionId: "version-1", sha256: hash }],
    records: [],
    items: [{ requirementId: "REQ-1", materialCheck: "满足材料要求", externalCheck: "未核验", detail: "字段满足要求", evidence: [{ fieldKey: "certificate_level", valueText: "一级", normalizedValue: "一级", origin: "material_text", confidence: null, subjectKey: "enterprise", materialVersionId: "version-1" }] }],
    coverage: { requirements: 1, compared: 1, materialSatisfied: 1, materialMissing: 0, fieldConflict: 0, dateUnsatisfied: 0, pending: 0, externalMatched: 0, externalUnverified: 1, externalOther: 0 },
    unfinished: [],
    warnings: [],
    errors: [],
    ...overrides,
  }
}

function summary(overrides: Partial<VerificationListSummary> = {}): VerificationListSummary {
  return {
    resultId: "result-1",
    kind: "bid-requirements",
    versionId: "version-1",
    sha256: hash,
    createdAt: "2026-10-29T00:00:00.000Z",
    createdBy: "account-1",
    origin: "machine",
    validation: { status: "valid", issues: [] },
    review: null,
    stale: { records: false, fields: false, hint: null },
    summary: { status: "confirmed", requirementCount: 1 },
    ...overrides,
  }
}

test("C4-UI: material roles separate requirement sources from field evidence", () => {
  assert.equal(requirementSourceMaterial(material()), true)
  assert.equal(requirementSourceMaterial(material({ coverage: { status: "failed", textLength: 0, pageCount: 1, findings: [] } })), false)
  assert.equal(requirementSourceMaterial(material({ format: "image", snapshotId: null, coverage: null })), false)
  assert.equal(evidenceMaterial(material()), true)
  assert.equal(evidenceMaterial(material({ format: "image", snapshotId: null, coverage: null })), true)
  assert.equal(materialUnavailableReason(material({ snapshotId: null, parseState: "running" })), "正在解析")
  assert.equal(materialTitle([material()], "version-1"), "招标文件")
  assert.equal(materialTitle([], "version-x"), "不可用的材料版本")
  assert.deepEqual(materialVersionRefs([material()]), [{ materialVersionId: "version-1", sha256: hash }])
})

test("C4-UI: task display is honest and polling stops at terminal states", () => {
  assert.equal(activeTask({ state: "queued" }), true)
  assert.equal(activeTask({ state: "running" }), true)
  assert.equal(activeTask({ state: "success" }), false)
  assert.equal(shouldPollVerificationTasks([{ state: "queued" }]), true)
  assert.equal(shouldPollVerificationTasks([{ state: "success" }, { state: "failed" }]), false)
  assert.equal(taskStateLabel("partial"), "部分完成")
  assert.equal(taskStageLabel({ state: "running", stage: "claimed" }), "正在处理")
  assert.equal(taskStageLabel({ state: "success", stage: "success" }), "处理结束")
  assert.equal(taskStageLabel({ state: "running", stage: "unknown" }), "正在处理")
  assert.equal(formatTaskElapsed({ elapsedMs: 61_000 }), "1 分 1 秒")
  assert.equal(formatTaskElapsed({ elapsedMs: Number.NaN }), "0 秒")
  assert.equal(verificationTasksOnly([task("bid-requirements"), { ...task("bid-requirements"), id: "t2", kind: "material-parse" }]).length, 1)
})

test("C4-UI: task rows merge newest first and only real active→terminal transitions are reported", () => {
  const first = task("bid-requirements", "queued")
  const second = task("bid-verification", "running", { id: "task-2", createdAt: "2026-10-29T01:00:00.000Z" })
  const rows = mergeTaskRows(mergeTaskRows([], first), second)
  assert.deepEqual(rows.map(item => item.id), ["task-2", "task-1"])
  const finishedRun = mergeTaskRows(rows, { ...second, state: "failed" })
  assert.deepEqual(finishedTasks(rows, finishedRun).map(item => item.id), ["task-2"])
  assert.deepEqual(finishedTasks([], finishedRun), [])
})

test("C4-UI: task result references are decoded defensively", () => {
  const reference = { resultId: "result-1", versionId: "version-1", sha256: hash, validation: "valid" }
  assert.deepEqual(parseTaskResultReference(JSON.stringify(reference)), reference)
  assert.equal(parseTaskResultReference(null), null)
  assert.equal(parseTaskResultReference("not-json"), null)
  assert.equal(parseTaskResultReference(JSON.stringify({ resultId: "r" })), null)
  assert.equal(parseTaskResultReference(JSON.stringify({ ...reference, sha256: "short" })), null)
})

test("C4-UI: submission signatures detect an identical active task and keep the idempotency key", () => {
  const submission = buildRequirementsSubmission({ materialIds: ["material-1"], asOf: "", consent: true }, [material()])
  assert.equal(submission.ready, true)
  const signature = submissionInputSignature("bid-requirements", submission.submission!.refs, submission.submission!.conditions)
  assert.equal(taskInputSignature(task("bid-requirements")), signature)
  assert.equal(findEquivalentActiveTask([task("bid-requirements")], signature)?.id, "task-1")
  assert.equal(findEquivalentActiveTask([task("bid-requirements", "success")], signature), null)
  let created = 0
  const createKey = () => `key-${++created}`
  const first = nextSubmissionOperation(null, signature, createKey)
  assert.deepEqual(nextSubmissionOperation(first, signature, createKey), first)
  assert.equal(nextSubmissionOperation(first, `${signature}x`, createKey).key, "key-2")
})

test("C4-UI: requirement set decode/count/status and comparison readiness mirror the server gates", () => {
  assert.equal(requirementSetStatusLabel(setValue()), "已确认要求集")
  assert.deepEqual(requirementSetCounts(setValue({ requirements: [requirement({ status: "pending", nature: "待确认" })] })),
    { total: 1, confirmed: 0, pending: 1, pendingNature: 1, rejected: 0 })
  assert.equal(comparisonReadiness(setValue()).ready, true)
  assert.equal(comparisonReadiness(setValue({ status: "candidate" })).ready, false)
  assert.equal(comparisonReadiness(setValue({ requirements: [requirement({ status: "pending" })] })).ready, false)
  assert.equal(comparisonReadiness(setValue({ requirements: [requirement({ nature: "待确认" })] })).ready, false)
  assert.equal(comparisonReadiness(setValue({ requirements: [requirement({ field: null, operator: null, value: null })] })).ready, false)
  const prepared = preparedRequirementSet(setValue({ requirements: [requirement({ status: "pending" })] }))
  assert.equal(prepared.status, "candidate")
  assert.equal(requirementSetValue(setValue())?.requirements.length, 1)
  assert.equal(requirementSetValue({ schemaVersion: 2 }), null)
  assert.equal(requirementSetValue({ schemaVersion: 1, status: "candidate", requirements: [] }), null)
})

test("C4-UI: single-requirement preflight mirrors the server structural rules", () => {
  assert.deepEqual(checkRequirementItem(requirement(), 0).issues, [])
  assert.ok(checkRequirementItem(requirement({ subject: "" }), 0).issues.some(issue => issue.includes("义务主体")))
  assert.ok(checkRequirementItem(requirement({ quote: "" }), 0).issues.some(issue => issue.includes("原文引文")))
  assert.ok(checkRequirementItem(requirement({ requirementId: "bad id!" }), 0).issues.some(issue => issue.includes("编号")))
  assert.ok(checkRequirementItem(requirement({ status: "confirmed", nature: "待确认" }), 0).issues.some(issue => issue.includes("性质待确认")))
  assert.ok(checkRequirementItem(requirement({ status: "confirmed", field: null, operator: null, value: null }), 0).issues.some(issue => issue.includes("缺少可执行")))
  assert.ok(checkRequirementItem(requirement({ field: "subject_name", operator: "on_or_before", value: "2026-01-01" }), 0).issues.some(issue => issue.includes("日期运算符")))
  assert.ok(checkRequirementItem(requirement({ group: { operator: "and", conditions: [] } }), 0).issues.some(issue => issue.includes("分组条件数量")))
  assert.ok(checkRequirementItem(requirement({ field: "certificate_level", operator: "contains", value: "一级", group: { operator: "and", conditions: [{ field: "subject_name", operator: "eq", value: "投标人" }] } }), 0).issues.some(issue => issue.includes("同时使用")))
  assert.ok(checkRequirementItem(requirement({ status: "pending", addendum: { state: "conflict", note: "" } }), 0).warnings.some(warning => warning.includes("补遗冲突")))
  const dateDeferred = requirement({ status: "confirmed", field: "expiry_date", operator: "on_or_after", value: null, asOfRule: "task_as_of" })
  assert.deepEqual(checkRequirementItem(dateDeferred, 0).issues, [])
  const dateBad = requirement({ status: "confirmed", field: "expiry_date", operator: "on_or_after", value: null, asOfRule: "not_applicable" })
  assert.ok(checkRequirementItem(dateBad, 0).issues.length > 0)
  assert.equal(requirementExpressionLabel(requirement()), "证照等级 包含 一级")
  assert.equal(requirementExpressionLabel(requirement({ group: { operator: "or", conditions: [{ field: "subject_name", operator: "eq", value: "投标人" }] } })), "主体名称 等于 投标人")
  assert.equal(fieldLabel("certificate_level"), "证照等级")
})

test("C4-UI: whole-set preflight rejects empty/duplicate/rejected inconsistencies", () => {
  assert.ok(checkRequirementSet(setValue({ requirements: [] })).issues.length > 0)
  const duplicate = setValue({ requirements: [requirement(), requirement({ same: true } as never)] })
  assert.ok(checkRequirementSet(duplicate).issues.some(issue => issue.includes("编号重复")))
  const rejected = setValue({ rejected: [{ quote: "原文", reason: "" }] })
  assert.ok(checkRequirementSet(rejected).issues.some(issue => issue.includes("驳回记录")))
  assert.deepEqual(checkRequirementSet(setValue()).issues, [])
})

test("C4-UI: manual requirements, updates and rejections keep immutable evidence", () => {
  const created = newManualRequirement(fragment(), material(), emptyRequirementSet())
  assert.equal(created.status, "pending")
  assert.equal(created.quote, fragment().text)
  assert.equal(created.source.fragmentId, "fragment-1")
  assert.equal(created.nature, "待确认")
  const updated = updateRequirement(setValue(), "REQ-1", { materialRelation: "人员证书" })
  assert.equal(updated.requirements[0].materialRelation, "人员证书")
  const rejected = rejectRequirement(setValue(), "REQ-1", "不属于资格要求")
  assert.equal(rejected.requirements.length, 0)
  assert.deepEqual(rejected.rejected, [{ quote: requirement().quote, reason: "不属于资格要求" }])
  const edited = updateRejectedReason(rejected, 0, "性质判断错误")
  assert.equal(edited.rejected[0].reason, "性质判断错误")
  assert.equal(quoteMatchesFragment(fragment().text, "建筑工程施工总承包一级资质"), true)
  assert.equal(quoteMatchesFragment(fragment().text, "不存在的引文"), false)
})

test("C4-UI: extraction form requires parsed materials, an optional day and the external-send consent", () => {
  const missing = buildRequirementsSubmission({ materialIds: [], asOf: "bad", consent: false }, [material()])
  assert.equal(missing.ready, false)
  assert.ok(missing.issues.some(issue => issue.includes("至少 1 份已解析")))
  assert.ok(missing.issues.some(issue => issue.includes("判定日期")))
  assert.ok(missing.issues.some(issue => issue.includes("第三方模型服务")))
  assert.equal(buildRequirementsSubmission({ materialIds: ["material-1"], asOf: "", consent: false }, [material({ snapshotId: null })]).ready, false)
  const ready = buildRequirementsSubmission({ materialIds: ["material-1"], asOf: "2026-10-29", consent: true }, [material()])
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.submission?.conditions, { externalProcessingConsent: true, asOf: "2026-10-29" })
})

test("C4-UI: comparison form requires a confirmed set, materials and an explicit judgment date", () => {
  const noSet = buildComparisonSubmission({ materialIds: ["material-1"], requirementSetResultId: "set-1", asOf: "", recordIds: [] }, [material()], null, [])
  assert.equal(noSet.ready, false)
  assert.ok(noSet.issues.some(issue => issue.includes("已确认的要求集")))
  assert.ok(noSet.issues.some(issue => issue.includes("判定日期")))
  const missingMaterials = buildComparisonSubmission({ materialIds: [], requirementSetResultId: "set-1", asOf: "2026-10-29", recordIds: [] }, [material()], { id: "set-1", versionId: "set-version-1", sha256: "d".repeat(64) }, [])
  assert.ok(missingMaterials.issues.some(issue => issue.includes("至少 1 份")))
  const records = [{ recordId: "record-1", sha256: "e".repeat(64), requirementSetVersionId: "set-version-1", requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T00:00:00.000Z", queryConditions: "条件", conclusion: "matched" as const, proofMaterialVersionId: "version-1", createdAt: "2026-10-29T00:00:00.000Z" }]
  const ready = buildComparisonSubmission({ materialIds: ["material-1"], requirementSetResultId: "set-1", asOf: "2026-10-29", recordIds: ["record-1"] }, [material()], { id: "set-1", versionId: "set-version-1", sha256: "d".repeat(64) }, records)
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.submission?.refs.externalRecords, [{ recordId: "record-1", sha256: "e".repeat(64) }])
  assert.deepEqual(ready.submission?.conditions, { asOf: "2026-10-29" })
  const unselectedRecord = buildComparisonSubmission({ materialIds: ["material-1"], requirementSetResultId: "set-1", asOf: "2026-10-29", recordIds: ["other"] }, [material()], { id: "set-1", versionId: "set-version-1", sha256: "d".repeat(64) }, records)
  assert.deepEqual(unselectedRecord.submission?.refs.externalRecords, [])
})

test("C4-UI: field form validation keeps material support honest", () => {
  const base = { fields: [], fragmentText: fragment().text }
  const supported = validateFieldForm({ fieldKey: "certificate_number", valueText: "证书编号 123", subjectKey: "enterprise", sourceFragmentId: "", reason: "" }, { fields: [], fragmentText: null })
  assert.equal(supported.ready, true)
  const mismatch = validateFieldForm({ fieldKey: "certificate_number", valueText: "证书编号 999", subjectKey: "enterprise", sourceFragmentId: "11111111-1111-4111-8111-111111111111", reason: "" }, base)
  assert.equal(mismatch.ready, false)
  assert.ok(mismatch.issues.some(issue => issue.includes("逐字核对")))
  const matched = validateFieldForm({ fieldKey: "certificate_level", valueText: "一级", subjectKey: "enterprise", sourceFragmentId: "11111111-1111-4111-8111-111111111111", reason: "" }, base)
  assert.equal(matched.ready, true)
  assert.equal(matched.write?.sourceFragmentId, "11111111-1111-4111-8111-111111111111")
  const current = [{ id: "field-1", materialId: "material-1", versionId: "version-1", subjectKey: "enterprise", fieldKey: "subject_name" as const, label: "主体名称", valueText: "示例公司", normalizedValue: "示例公司", origin: "manual" as const, support: "pending" as const, sourceSnapshotId: null, sourceFragmentId: null, ocrRunId: null, confidence: null, revision: 1, previousId: null, supersededAt: null, reason: null, createdBy: "a", createdAt: "t" }]
  const correctionWithoutReason = validateFieldForm({ fieldKey: "subject_name", valueText: "示例公司", subjectKey: "enterprise", sourceFragmentId: "", reason: "" }, { fields: current, fragmentText: null })
  assert.equal(correctionWithoutReason.ready, false)
  assert.ok(correctionWithoutReason.issues.some(issue => issue.includes("更正理由")))
  const badDate = validateFieldForm({ fieldKey: "expiry_date", valueText: "2026-13-99", subjectKey: "enterprise", sourceFragmentId: "", reason: "" }, { fields: [], fragmentText: null })
  assert.equal(badDate.ready, false)
  const badSubject = validateFieldForm({ fieldKey: "subject_name", valueText: "示例公司", subjectKey: "bad subject!", sourceFragmentId: "", reason: "" }, { fields: [], fragmentText: null })
  assert.equal(badSubject.ready, false)
  assert.equal(fieldFormFromView(current[0]).valueText, "示例公司")
})

test("C4-UI: external record form validation requires sourced, concluded evidence", () => {
  const requirementIds = new Set(["REQ-1"])
  const proofVersionIds = new Set(["version-1"])
  const missing = validateExternalRecordForm({ requirementId: "", subject: "", certificateNo: "", source: "", queriedAt: "", queryConditions: "", conclusion: "", proofMaterialVersionId: "" }, { requirementIds, proofVersionIds })
  assert.equal(missing.ready, false)
  assert.equal(missing.issues.length, 8)
  const valid = validateExternalRecordForm({ requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "全国建筑市场监管公共服务平台", queriedAt: "2026-10-29T10:00", queryConditions: "按证号查询", conclusion: "matched", proofMaterialVersionId: "version-1" }, { requirementIds, proofVersionIds })
  assert.equal(valid.ready, true)
  // A datetime-local value without an offset is parsed in the runtime timezone. The
  // expected value must follow that same rule, not assume UTC+8 (GitHub Actions runs UTC).
  assert.equal(valid.value?.queriedAt, new Date("2026-10-29T10:00").toISOString())
  const withOffset = validateExternalRecordForm({ requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T10:00:00+08:00", queryConditions: "条件", conclusion: "matched", proofMaterialVersionId: "version-1" }, { requirementIds, proofVersionIds })
  assert.equal(withOffset.value?.queriedAt, "2026-10-29T02:00:00.000Z")
  const utc = validateExternalRecordForm({ requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T02:00:00Z", queryConditions: "条件", conclusion: "matched", proofMaterialVersionId: "version-1" }, { requirementIds, proofVersionIds })
  assert.equal(utc.value?.queriedAt, "2026-10-29T02:00:00.000Z")
  const wrongRequirement = validateExternalRecordForm({ requirementId: "REQ-9", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T10:00", queryConditions: "条件", conclusion: "matched", proofMaterialVersionId: "version-1" }, { requirementIds, proofVersionIds })
  assert.ok(wrongRequirement.issues.some(issue => issue.includes("要求")))
  const unknownProof = validateExternalRecordForm({ requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T10:00", queryConditions: "条件", conclusion: "matched", proofMaterialVersionId: "version-9" }, { requirementIds, proofVersionIds })
  assert.ok(unknownProof.issues.some(issue => issue.includes("证明材料版本")))
  assert.equal(normalizeQueriedAt("not-a-time"), null)
  const prefill = recordFormFromRequirement(comparisonValue().requirementSet.requirements[0], comparisonValue().items[0].evidence)
  assert.equal(prefill.subject, "投标人")
  assert.equal(prefill.certificateNo, "")
})

test("C4-UI: comparison result projections keep the two statuses independent", () => {
  const value = comparisonValue()
  const rows = verificationItemRows(value)
  assert.equal(rows[0].materialCheck, "满足材料要求")
  assert.equal(rows[0].externalCheck, "未核验")
  assert.equal(externalStatusIsPass("人工查询记录匹配"), true)
  assert.equal(externalStatusIsPass("未核验"), false)
  assert.equal(externalStatusIsPass("未查到"), false)
  assert.match(coverageSummaryLabel(value), /外部未核验 1 项/)
  assert.equal(bidVerificationValue(value)?.asOf, "2026-10-29")
  assert.equal(bidVerificationValue({ schemaVersion: 2 }), null)
  assert.equal(bidVerificationValue({ schemaVersion: 1, status: "success", items: [] }), null)
  assert.equal(staleHint({ records: true, fields: false, hint: "记录/字段已更新，需重新运行。" }), "记录/字段已更新，需重新运行。")
  assert.equal(staleHint(null), "")
})

test("C4-UI: review and export gates never pass an invalid or unfinished result", () => {
  const valid = { status: "valid" as const, versionId: "v", checkedAt: "t", issues: [] }
  const invalid = { status: "invalid" as const, versionId: "v", checkedAt: "t", issues: [] }
  assert.equal(couldExport(true, "bid-verification", valid).canExport, true)
  assert.equal(couldExport(true, "bid-verification", { status: "partial" }).canExport, true)
  assert.equal(couldExport(true, "bid-verification", invalid).canExport, false)
  assert.equal(couldExport(true, "bid-requirements", valid).canExport, false)
  assert.equal(couldExport(false, "bid-verification", valid).canExport, false)
  assert.equal(couldExport(true, "bid-verification", invalid).hint, "成果校验未通过，不能导出。")
})

test("C4-UI: lists expose only confirmed requirement sets for comparison", () => {
  const confirmed = summary({ resultId: "set-1" })
  const pending = summary({ resultId: "set-2", summary: { status: "candidate", requirementCount: 2, pendingCount: 1 } })
  const invalid = summary({ resultId: "set-3", validation: { status: "invalid", issues: [] } })
  const comparison = summary({ resultId: "cmp-1", kind: "bid-verification", summary: { status: "success", requirementCount: 1, materialSatisfied: 1, externalMatched: 0, unfinished: 0 } })
  assert.deepEqual(comparisonRequirementSetOptions([confirmed, pending, invalid, comparison]).map(item => item.resultId), ["set-1"])
  assert.deepEqual(verificationListItems([confirmed, comparison], "bid-verification").map(item => item.resultId), ["cmp-1"])
  assert.equal(operatorLabels.on_or_before, "不晚于")
})

test("C4-UI: fragment helpers locate, filter and preview source text", () => {
  const table = fragment({ id: "fragment-2", kind: "table", paragraph: null, tableIndex: 1, row: 2, column: 1, headingPath: ["资格要求", "资质等级"], text: "投标人名称与证号应与营业执照一致。" })
  assert.match(fragmentLocationLabel(table), /资格要求 › 资质等级/)
  assert.match(fragmentLocationLabel(table), /第 3 行第 2 列/)
  assert.equal(filterFragments([fragment(), table], "施工总承包").length, 1)
  assert.equal(filterFragments([fragment(), table], "").length, 2)
  assert.equal(fragmentPreview(fragment(), 10).endsWith("…"), true)
  assert.equal(snapshotReadable({ fragments: [fragment()] } as never), true)
  assert.equal(snapshotReadable(null), false)
})
