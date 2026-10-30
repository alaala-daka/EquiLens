import assert from "node:assert/strict"
import { test } from "node:test"
import type {
  BidVerificationValue, ExternalRecordSnapshot, RequirementSnapshot,
} from "../../lib/business/verification-types"
import { normalizeFieldValue, type VerificationFieldKey } from "../../lib/business/verification-fields"
import type { VerificationFieldValue } from "./field-source"
import { compareRequirements } from "./compare"
import { bidVerificationResultValidator } from "./validation"

/**
 * C4-VERIFY result validator contract (spec 01 §8.2.3, plan §4.7/§5).
 *
 * The validator re-checks a saved machine value without database or model
 * access: structure, requirement/material/record snapshot consistency, shared
 * field vocabulary and confidence, the two independent status mappings and the
 * unfinished list. Structural/reference/record-integrity violations are
 * `invalid`; honest external 未核验/未查到/查询失败 states are never invalid on
 * their own. Review fixes kept here: low-confidence OCR evidence yields
 * 待确认/partial, matched records must bind to the requirement 义务主体, evidence
 * carries a validated confidence, and the requirement count is capped.
 */
const asOf = "2026-10-29"
const materialVersionId = "certificate-version"
const bidder = "华建机电安装有限公司"

function requirement(overrides: Partial<RequirementSnapshot> = {}): RequirementSnapshot {
  return {
    requirementId: "req-1",
    subject: bidder,
    quote: "投标人应具有有效的营业执照。",
    source: { snapshotId: "snapshot-tender", fragmentId: "fragment-1" },
    materialVersionId: "tender-version",
    nature: "资格否决",
    field: "subject_name",
    operator: "eq",
    value: bidder,
    asOfRule: "task_as_of",
    addendumState: "none",
    materialRelation: "企业营业执照",
    group: null,
    ...overrides,
  }
}

function fieldValue(fieldKey: VerificationFieldKey, valueText: string, options: {
  subjectKey?: string
  origin?: "ocr" | "manual" | "material_text"
  confidence?: number | null
} = {}): VerificationFieldValue {
  return {
    materialId: "certificate-material",
    versionId: materialVersionId,
    subjectKey: options.subjectKey ?? "enterprise",
    fieldKey,
    label: fieldKey,
    valueText,
    normalizedValue: normalizeFieldValue(fieldKey, valueText),
    origin: options.origin ?? "material_text",
    sourceSnapshotId: "snapshot-certificate",
    sourceFragmentId: "fragment-certificate",
    ocrRunId: null,
    confidence: options.confidence ?? null,
    revision: 1,
    updatedAt: "2026-10-29T00:00:00.000Z",
  }
}

function record(requirementId: string, overrides: Partial<ExternalRecordSnapshot> = {}): ExternalRecordSnapshot {
  return {
    recordId: "record-1",
    sha256: "c".repeat(64),
    requirementId,
    subject: bidder,
    certificateNo: "91310000MA1FL0XX2A",
    source: "全国建筑市场监管公共服务平台",
    queriedAt: "2026-10-29T00:00:00.000Z",
    queryConditions: "按统一社会信用代码查询",
    conclusion: "matched",
    proofMaterialVersionId: materialVersionId,
    ...overrides,
  }
}

const defaultFields = () => [
  fieldValue("subject_name", bidder),
  fieldValue("unified_social_credit_code", "91310000MA1FL0XX2A"),
]

function buildValue(options: {
  requirements?: RequirementSnapshot[]
  fieldValues?: VerificationFieldValue[]
  records?: ExternalRecordSnapshot[]
} = {}): BidVerificationValue {
  const requirements = options.requirements ?? [requirement()]
  const fieldValues = options.fieldValues ?? defaultFields()
  const records = options.records ?? []
  const compared = compareRequirements({ requirements, fieldValues, records, asOf })
  return {
    schemaVersion: 1,
    status: compared.status,
    asOf,
    requirementSet: { id: "result-1", versionId: "version-1", sha256: "a".repeat(64), requirements },
    materials: [{ materialId: "certificate-material", versionId: materialVersionId, sha256: "b".repeat(64) }],
    records,
    items: compared.items,
    coverage: compared.coverage,
    unfinished: compared.unfinished,
    warnings: compared.warnings,
    errors: compared.errors,
  }
}

const validate = async (value: unknown) => bidVerificationResultValidator(value)
const clone = (value: BidVerificationValue): BidVerificationValue => JSON.parse(JSON.stringify(value)) as BidVerificationValue

test("validation: a complete comparison with honest 未核验 external state is valid", async () => {
  const result = await validate(buildValue())
  assert.equal(result.status, "valid")
  assert.deepEqual(result.issues, [])
})

test("validation: 未查到/查询失败/待人工核验/记录冲突 are honest external states and do not make the result invalid", async () => {
  for (const conclusion of ["not_found", "query_failed", "pending", "conflict"] as const) {
    const value = buildValue({ records: [record("req-1", { conclusion })] })
    const result = await validate(value)
    assert.equal(result.status, "valid", conclusion)
  }
})

test("validation: a 待确认 requirement makes the result partial (saveable, exportable as draft, not approvable)", async () => {
  const conflict = buildValue({ requirements: [requirement({ addendumState: "conflict" })] })
  assert.equal(conflict.status, "partial")
  assert.equal((await validate(conflict)).status, "partial")
  // Low-confidence OCR evidence is 待确认 → partial, not invalid; a matched
  // external state stays independently honest.
  const lowConfidence = buildValue({
    requirements: [requirement({ addendumState: "none" })],
    fieldValues: [fieldValue("subject_name", bidder, { origin: "ocr", confidence: 55 }), fieldValue("unified_social_credit_code", "91310000MA1FL0XX2A")],
  })
  assert.equal(lowConfidence.status, "partial")
  assert.equal(lowConfidence.items[0].materialCheck, "待确认")
  const result = await validate(lowConfidence)
  assert.equal(result.status, "partial")
  assert.deepEqual(result.issues, [])
})

test("validation: date requirements with asOfRule=task_as_of and no fixed date are valid (task asOf baseline)", async () => {
  const value = buildValue({
    requirements: [requirement({ field: "expiry_date", operator: "on_or_after", value: null, asOfRule: "task_as_of" })],
    fieldValues: [fieldValue("subject_name", bidder), fieldValue("expiry_date", "2028-12-31")],
  })
  assert.equal(value.items[0].materialCheck, "满足材料要求")
  const result = await validate(value)
  assert.equal(result.status, "valid")
  assert.deepEqual(result.issues, [])
  // A null-date snapshot with not_applicable is not expressible and therefore invalid.
  const invalidBaseline = clone(value)
  invalidBaseline.requirementSet.requirements[0].asOfRule = "not_applicable"
  assert.equal((await validate(invalidBaseline)).status, "invalid")
})

test("validation: structural and vocabulary violations are invalid", async () => {
  const mutations: Array<[string, (value: BidVerificationValue) => void]> = [
    ["非对象", value => { Object.setPrototypeOf(value, null); delete (value as unknown as Record<string, unknown>).schemaVersion }],
    ["成果版本", value => { (value as unknown as { schemaVersion: number }).schemaVersion = 2 }],
    ["执行状态", value => { (value as unknown as { status: string }).status = "failed" }],
    ["判定日期", value => { value.asOf = "2026/10/29" }],
    ["要求集摘要", value => { value.requirementSet.sha256 = "not-a-sha" }],
    ["词表外字段", value => { value.requirementSet.requirements[0].field = "salary" as never }],
    ["未知运算符", value => { value.requirementSet.requirements[0].operator = "like" as never }],
    ["缺少义务主体", value => { value.requirementSet.requirements[0].subject = "" }],
    ["重复要求编号", value => { value.requirementSet.requirements = [requirement(), requirement()] }],
    ["材料快照缺失", value => { value.materials = [] }],
    ["材料摘要无效", value => { value.materials[0].sha256 = "x" }],
    ["条目缺失", value => { value.items = [] }],
    ["条目引用未知要求", value => { value.items[0].requirementId = "req-unknown" }],
    ["证据字段未知", value => { value.items[0].evidence[0].fieldKey = "salary" as never }],
    ["证据材料版本未知", value => { value.items[0].evidence[0].materialVersionId = "other-version" }],
    ["证据来源未知", value => { value.items[0].evidence[0].origin = "official" as never }],
    ["证据置信度越界", value => { value.items[0].evidence[0].confidence = 150 }],
    ["证据置信度非整数", value => { value.items[0].evidence[0].confidence = 88.5 }],
    ["非 OCR 证据带置信度", value => { value.items[0].evidence[0].origin = "manual"; value.items[0].evidence[0].confidence = 90 }],
    ["材料检查状态未知", value => { value.items[0].materialCheck = "通过" as never }],
    ["外部状态未知", value => { value.items[0].externalCheck = "已通过" as never }],
    ["条目说明为空", value => { value.items[0].detail = "" }],
  ]
  for (const [name, mutate] of mutations) {
    const value = clone(buildValue())
    mutate(value)
    const result = await validate(value)
    assert.equal(result.status, "invalid", name)
    assert.ok(result.issues.length > 0, name)
  }
})

test("validation: the requirement snapshot count is capped", async () => {
  const value = clone(buildValue())
  const base = value.requirementSet.requirements[0]
  value.requirementSet.requirements = Array.from({ length: 201 }, (_, index) => ({ ...base, requirementId: `req-${index}` }))
  const result = await validate(value)
  assert.equal(result.status, "invalid")
  assert.ok(result.issues.some(issue => /上限/.test(issue.message)))
})

test("validation: requirement/material/record snapshot consistency and record integrity are invalid", async () => {
  // matched record for another requirement
  const foreignRecord = clone(buildValue({ records: [record("req-1")] }))
  foreignRecord.records[0].requirementId = "req-other"
  assert.equal((await validate(foreignRecord)).status, "invalid")

  // matched record whose subject does not match the compared evidence
  const mismatch = clone(buildValue({ records: [record("req-1", { subject: "海联机电安装有限公司" })] }))
  assert.equal(mismatch.items[0].externalCheck, "记录冲突")
  mismatch.items[0].externalCheck = "人工查询记录匹配"
  assert.equal((await validate(mismatch)).status, "invalid")

  // matched record whose cert number does not match the compared evidence
  const numberMismatch = clone(buildValue({ records: [record("req-1", { certificateNo: "91310000MA1FL0XX2B" })] }))
  numberMismatch.items[0].externalCheck = "人工查询记录匹配"
  assert.equal((await validate(numberMismatch)).status, "invalid")

  // a matched record bound to the evidence but not to the requirement 义务主体
  const subjectBound = buildValue({
    requirements: [requirement({ subject: "海联机电安装有限公司" })],
    fieldValues: [fieldValue("subject_name", "海联机电安装有限公司"), fieldValue("unified_social_credit_code", "91310000MA1FL0XX2A")],
    records: [record("req-1", { subject: "海联机电安装有限公司" })],
  })
  assert.equal(subjectBound.items[0].externalCheck, "人工查询记录匹配")
  assert.equal((await validate(subjectBound)).status, "valid")
  const rebound = clone(subjectBound)
  rebound.requirementSet.requirements[0].subject = bidder
  assert.equal((await validate(rebound)).status, "invalid")

  // two matched records where only one matches the evidence: the record set conflicts
  const mixed = clone(buildValue({ records: [record("req-1"), record("req-1", { recordId: "record-2", subject: "海联机电安装有限公司" })] }))
  assert.equal(mixed.items[0].externalCheck, "记录冲突")
  mixed.items[0].externalCheck = "人工查询记录匹配"
  assert.equal((await validate(mixed)).status, "invalid")

  // required record fields are incomplete
  for (const field of ["source", "queryConditions", "proofMaterialVersionId", "subject", "certificateNo", "queriedAt"] as const) {
    const incomplete = clone(buildValue({ records: [record("req-1")] }))
    ;(incomplete.records[0] as unknown as Record<string, unknown>)[field] = ""
    const result = await validate(incomplete)
    assert.equal(result.status, "invalid", field)
  }
  const unknownConclusion = clone(buildValue({ records: [record("req-1")] }))
  ;(unknownConclusion.records[0] as unknown as Record<string, unknown>).conclusion = "passed"
  assert.equal((await validate(unknownConclusion)).status, "invalid")

  // claimed external match without any pinned record
  const claimed = clone(buildValue())
  claimed.items[0].externalCheck = "人工查询记录匹配"
  assert.equal((await validate(claimed)).status, "invalid")

  // external 未核验 while records are present is an inconsistent mapping
  const inconsistent = clone(buildValue({ records: [record("req-1")] }))
  assert.equal(inconsistent.items[0].externalCheck, "人工查询记录匹配")
  inconsistent.items[0].externalCheck = "未核验"
  assert.equal((await validate(inconsistent)).status, "invalid")
})

test("validation: status/coverage/unfinished consistency and evidence presence are invalid", async () => {
  const partial = clone(buildValue({ requirements: [requirement({ addendumState: "conflict" })] }))
  const wrongSuccess = clone(partial)
  wrongSuccess.status = "success"
  assert.equal((await validate(wrongSuccess)).status, "invalid")

  const noPending = clone(buildValue())
  noPending.status = "partial"
  assert.equal((await validate(noPending)).status, "invalid")

  const wrongCoverage = clone(buildValue())
  wrongCoverage.coverage.materialSatisfied = 0
  assert.equal((await validate(wrongCoverage)).status, "invalid")

  const missingUnfinished = clone(buildValue())
  missingUnfinished.unfinished = []
  assert.equal((await validate(missingUnfinished)).status, "invalid")

  const unknownUnfinished = clone(buildValue())
  unknownUnfinished.unfinished.push({ requirementId: "req-unknown", reason: "未知" })
  assert.equal((await validate(unknownUnfinished)).status, "invalid")

  const passWithoutEvidence = clone(buildValue())
  passWithoutEvidence.items[0].evidence = []
  assert.equal(passWithoutEvidence.items[0].materialCheck, "满足材料要求")
  assert.equal((await validate(passWithoutEvidence)).status, "invalid")

  const missingWithEvidence = clone(buildValue({
    requirements: [requirement({ field: "certificate_number", operator: "eq", value: "(沪)JZ安许证字[2026]000001" })],
    fieldValues: [fieldValue("subject_name", bidder)],
  }))
  assert.equal(missingWithEvidence.items[0].materialCheck, "材料缺失")
  missingWithEvidence.items[0].evidence = [{
    fieldKey: "certificate_number", valueText: "(沪)JZ安许证字[2026]000001",
    normalizedValue: normalizeFieldValue("certificate_number", "(沪)JZ安许证字[2026]000001"),
    origin: "material_text", confidence: null, subjectKey: "enterprise", materialVersionId,
  }]
  assert.equal((await validate(missingWithEvidence)).status, "invalid")
})

test("validation: array/shape pollution such as unknown item fields is rejected", async () => {
  const extraKeys = clone(buildValue())
  ;(extraKeys.items[0] as unknown as Record<string, unknown>).officialPass = true
  const result = await validate(extraKeys)
  assert.equal(result.status, "invalid")
  const recordExtra = clone(buildValue({ records: [record("req-1")] }))
  ;(recordExtra.records[0] as unknown as Record<string, unknown>).officialApi = true
  assert.equal((await validate(recordExtra)).status, "invalid")
})
