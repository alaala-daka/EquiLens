import assert from "node:assert/strict"
import { test } from "node:test"
import type { BidVerificationValue, ExternalRecordSnapshot, RequirementSnapshot } from "../../lib/business/verification-types"
import { normalizeFieldValue } from "../../lib/business/verification-fields"
import { compareRequirements } from "./compare"
import { bidVerificationReportTemplate } from "./export-template"
import { BusinessError } from "../projects/errors"
import type { VerificationFieldValue } from "./field-source"

/**
 * C4 export template contract (plan §4.7/§5): `bid-verification-report-v1` renders
 * only the saved value — two independent status columns, requirements/sources,
 * manual-record metadata, unresolved list and disclaimers; invalid values cannot
 * render, and the template blocks invalid results at export time.
 */
const asOf = "2026-10-29"
const materialVersionId = "certificate-version"

function requirement(overrides: Partial<RequirementSnapshot> = {}): RequirementSnapshot {
  return {
    requirementId: "req-1",
    subject: "华建机电安装有限公司",
    quote: "投标人应具有有效的营业执照。",
    source: { snapshotId: "snapshot-tender", fragmentId: "fragment-1" },
    materialVersionId: "tender-version",
    nature: "资格否决",
    field: "subject_name",
    operator: "eq",
    value: "华建机电安装有限公司",
    asOfRule: "task_as_of",
    addendumState: "none",
    materialRelation: "企业营业执照",
    group: null,
    ...overrides,
  }
}

function fieldValue(fieldKey: "subject_name" | "unified_social_credit_code", valueText: string): VerificationFieldValue {
  return {
    materialId: "certificate-material", versionId: materialVersionId, subjectKey: "enterprise", fieldKey, label: fieldKey,
    valueText, normalizedValue: normalizeFieldValue(fieldKey, valueText), origin: "material_text", sourceSnapshotId: "snapshot-certificate",
    sourceFragmentId: "fragment-certificate", ocrRunId: null, confidence: null, revision: 1, updatedAt: "2026-10-29T00:00:00.000Z",
  }
}

function record(): ExternalRecordSnapshot {
  return {
    recordId: "record-1", sha256: "c".repeat(64), requirementId: "req-1", subject: "华建机电安装有限公司",
    certificateNo: "91310000MA1FL0XX2A", source: "全国建筑市场监管公共服务平台", queriedAt: "2026-10-29T00:00:00.000Z",
    queryConditions: "按统一社会信用代码查询", conclusion: "matched", proofMaterialVersionId: materialVersionId,
  }
}

function buildValue(options: { requirements?: RequirementSnapshot[]; records?: ExternalRecordSnapshot[] } = {}): BidVerificationValue {
  const requirements = options.requirements ?? [requirement()]
  const records = options.records ?? [record()]
  const compared = compareRequirements({
    requirements, fieldValues: [fieldValue("subject_name", "华建机电安装有限公司"), fieldValue("unified_social_credit_code", "91310000MA1FL0XX2A")],
    records, asOf,
  })
  return {
    schemaVersion: 1, status: compared.status, asOf,
    requirementSet: { id: "result-1", versionId: "version-1", sha256: "a".repeat(64), requirements },
    materials: [{ materialId: "certificate-material", versionId: materialVersionId, sha256: "b".repeat(64) }],
    records, items: compared.items, coverage: compared.coverage, unfinished: compared.unfinished,
    warnings: compared.warnings, errors: compared.errors,
  }
}

test("export template: bid-verification-report-v1 keeps two status columns, sources, records and unresolved items", () => {
  assert.equal(bidVerificationReportTemplate.version, "bid-verification-report-v1")
  assert.equal(bidVerificationReportTemplate.blocksInvalidResult, true)
  const lines = bidVerificationReportTemplate.paragraphs(buildValue())
  const text = lines.join("\n")
  assert.match(text, /投标材料核验报告/)
  assert.match(text, /服务端确定性比较生成的机器成果/)
  assert.match(text, /判定日期：2026-10-29/)
  assert.match(text, /两组状态独立/)
  assert.match(text, /材料检查：满足材料要求 · 外部真实性：人工查询记录匹配/)
  assert.match(text, /原文：投标人应具有有效的营业执照/)
  assert.match(text, /来源：snapshot-tender\/fragment-1/)
  assert.match(text, /全国建筑市场监管公共服务平台/)
  assert.match(text, /不代表系统实时官方查询/)
  assert.match(text, /人工查询记录匹配/)
  assert.match(text, /未完成事项/)
  assert.match(text, /不代表投标人资格真实或材料齐全/)
})

test("export template: partial results are marked and unresolved external states are listed, not passed", () => {
  const partial = buildValue({ requirements: [requirement({ addendumState: "conflict" })], records: [] })
  const text = bidVerificationReportTemplate.paragraphs(partial).join("\n")
  assert.match(text, /部分完成（存在待确认要求）/)
  assert.match(text, /补遗冲突，待人工确认/)
  assert.match(text, /未核验/)
  assert.match(text, /不构成真实性通过/)
  const failedExternal = buildValue({ records: [{ ...record(), conclusion: "not_found" }] })
  const recordText = bidVerificationReportTemplate.paragraphs(failedExternal).join("\n")
  assert.match(recordText, /未查到/)
  assert.match(recordText, /不构成真实性通过/)
})

test("export template: invalid or forged values cannot render", () => {
  for (const value of [null, undefined, {}, { schemaVersion: 2 }, { schemaVersion: 1, status: "success" }]) {
    assert.throws(() => bidVerificationReportTemplate.paragraphs(value), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
  }
  const tampered = buildValue()
  tampered.items[0].externalCheck = "人工查询记录匹配"
  tampered.records = []
  assert.throws(() => bidVerificationReportTemplate.paragraphs(tampered), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
})
