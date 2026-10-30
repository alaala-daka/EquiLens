import {
  ADDENDUM_STATES, AS_OF_RULES, COMPARISON_OPERATORS, DATE_OPERATORS, EXTERNAL_CHECK_STATUSES,
  EXTERNAL_RECORD_CONCLUSIONS, LIST_OPERATORS, MATERIAL_CHECK_STATUSES, REQUIREMENT_NATURES,
  type BidVerificationValue, type ExternalRecordSnapshot, type MaterialSnapshot, type RequirementCondition,
  type RequirementGroup, type RequirementSnapshot, type VerificationCoverage, type VerificationEvidence,
  type VerificationItem, type VerificationUnfinished,
} from "../../lib/business/verification-types"
import {
  VERIFICATION_FIELD_TYPES, isVerificationFieldKey, normalizeDateValue, normalizeFieldValue,
} from "../../lib/business/verification-fields"
import type { ResultValidator } from "../results/validation"
import { mapExternalCheck } from "./compare"
import { MAX_REQUIREMENTS } from "./requirements"
import { DAY_PATTERN, SHA256_PATTERN, record, text } from "./types"

/**
 * C4-VERIFY result validator (spec 01 §8.2.3, plan §4.7).
 *
 * Re-derives the saved comparison value from scratch: structure, requirement /
 * material / record snapshot consistency, shared field vocabulary, recomputed
 * normalized evidence, the two independent status mappings and the unfinished
 * list. Status policy frozen by the spec:
 * - invalid: structural, reference or record-integrity violations (including a
 *   claimed external match whose subject/certificate does not match the evidence);
 * - partial: the comparison itself is incomplete (at least one 待确认 item);
 * - valid: completed deterministic comparison; honest external states such as
 *   未核验/未查到/查询失败/待人工核验 never make the result invalid on their own.
 */
type Issue = { code: string; message: string; ref?: string }

const ROOT_KEYS = ["schemaVersion", "status", "asOf", "requirementSet", "materials", "records", "items", "coverage", "unfinished", "warnings", "errors"]
const SET_KEYS = ["id", "versionId", "sha256", "requirements"]
const SNAPSHOT_KEYS = ["requirementId", "subject", "quote", "source", "materialVersionId", "nature", "field", "operator", "value", "asOfRule", "addendumState", "materialRelation", "group"]
const SOURCE_KEYS = ["snapshotId", "fragmentId"]
const MATERIAL_KEYS = ["materialId", "versionId", "sha256"]
const RECORD_KEYS = ["recordId", "sha256", "requirementId", "subject", "certificateNo", "source", "queriedAt", "queryConditions", "conclusion", "proofMaterialVersionId"]
const ITEM_KEYS = ["requirementId", "materialCheck", "externalCheck", "detail", "evidence"]
const EVIDENCE_KEYS = ["fieldKey", "valueText", "normalizedValue", "origin", "confidence", "subjectKey", "materialVersionId"]
const COVERAGE_KEYS = ["requirements", "compared", "materialSatisfied", "materialMissing", "fieldConflict", "dateUnsatisfied", "pending", "externalMatched", "externalUnverified", "externalOther"]
const UNFINISHED_KEYS = ["requirementId", "reason"]

const MAX_RECORDS = 200
const MAX_EVIDENCE = 50

function issue(issues: Issue[], code: string, message: string, ref?: string): void {
  issues.push(ref ? { code, message, ref } : { code, message })
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function identifier(value: unknown): string {
  const parsed = text(value)
  return parsed && parsed.length <= 128 ? parsed : ""
}

function isOperator(value: unknown): value is RequirementCondition["operator"] {
  return typeof value === "string" && (COMPARISON_OPERATORS as readonly string[]).includes(value)
}

function expressionValue(operator: RequirementCondition["operator"], value: unknown): string | string[] | null {
  if (LIST_OPERATORS.includes(operator)) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null
    const items = value.map(item => (typeof item === "string" ? item.trim() : ""))
    return items.every(Boolean) && items.every(item => item.length <= 200) ? items : null
  }
  if (typeof value !== "string") return null
  const parsed = value.trim()
  return parsed && parsed.length <= 500 ? parsed : null
}

function parseGroup(raw: unknown, ref: string, issues: Issue[]): RequirementGroup | null {
  if (raw === null || raw === undefined) return null
  const group = record(raw)
  if (!group || !exactKeys(group, ["operator", "conditions"]) || Object.keys(group).length !== 2) {
    issue(issues, "INVALID_REFERENCE", "要求快照的分组结构无效。", ref)
    return null
  }
  if (group.operator !== "and" && group.operator !== "or") {
    issue(issues, "INVALID_REFERENCE", "要求快照的分组运算无效。", ref)
    return null
  }
  if (!Array.isArray(group.conditions) || group.conditions.length < 1 || group.conditions.length > 10) {
    issue(issues, "INVALID_REFERENCE", "要求快照的分组缺少条件。", ref)
    return null
  }
  const conditions: RequirementCondition[] = []
  for (const [index, rawCondition] of group.conditions.entries()) {
    const condition = record(rawCondition)
    if (!condition || !exactKeys(condition, ["field", "operator", "value"]) || Object.keys(condition).length !== 3) {
      issue(issues, "INVALID_REFERENCE", "要求快照的分组条件结构无效。", `${ref}.conditions[${index}]`)
      return null
    }
    if (!isVerificationFieldKey(condition.field) || !isOperator(condition.operator)) {
      issue(issues, "INVALID_REFERENCE", "要求快照的分组条件字段或运算无效。", `${ref}.conditions[${index}]`)
      return null
    }
    const value = expressionValue(condition.operator, condition.value)
    if (value === null) {
      issue(issues, "INVALID_REFERENCE", "要求快照的分组条件比较值无效。", `${ref}.conditions[${index}]`)
      return null
    }
    if (DATE_OPERATORS.includes(condition.operator) && VERIFICATION_FIELD_TYPES[condition.field] !== "date") {
      issue(issues, "INVALID_REFERENCE", "要求快照的日期运算与字段类型不符。", `${ref}.conditions[${index}]`)
      return null
    }
    conditions.push({ field: condition.field, operator: condition.operator, value })
  }
  return { operator: group.operator, conditions }
}

function inspectSnapshot(raw: unknown, index: number, issues: Issue[], seen: Set<string>): RequirementSnapshot | null {
  const ref = `requirementSet.requirements[${index}]`
  const value = record(raw)
  if (!value || !exactKeys(value, SNAPSHOT_KEYS)) { issue(issues, "INVALID_REFERENCE", "要求集快照结构无效。", ref); return null }
  const requirementId = identifier(value.requirementId)
  if (!requirementId || seen.has(requirementId)) { issue(issues, "INVALID_REFERENCE", "要求集快照编号缺失或重复。", ref); return null }
  seen.add(requirementId)
  const subject = text(value.subject)
  if (!subject || subject.length > 200) issue(issues, "INVALID_REFERENCE", "要求集快照缺少义务主体。", ref)
  const quote = text(value.quote)
  if (!quote || quote.length > 2000) issue(issues, "INVALID_REFERENCE", "要求集快照缺少原文引文。", ref)
  const materialVersionId = identifier(value.materialVersionId)
  if (!materialVersionId) issue(issues, "INVALID_REFERENCE", "要求集快照缺少来源材料版本。", ref)
  const source = record(value.source)
  const snapshotId = identifier(source?.snapshotId)
  const fragmentId = identifier(source?.fragmentId)
  if (!source || !exactKeys(source, SOURCE_KEYS) || !snapshotId || !fragmentId) {
    issue(issues, "INVALID_REFERENCE", "要求集快照缺少来源片段引用。", ref)
  }
  const nature = text(value.nature)
  if (!(REQUIREMENT_NATURES as readonly string[]).includes(nature)) {
    issue(issues, "INVALID_REFERENCE", "要求集快照的性质不是已确认性质。", ref)
  }
  const field = value.field ?? null
  if (field !== null && !isVerificationFieldKey(field)) issue(issues, "INVALID_REFERENCE", "要求集快照的字段不在词表内。", ref)
  const operator = value.operator ?? null
  if (operator !== null && !isOperator(operator)) issue(issues, "INVALID_REFERENCE", "要求集快照的比较运算符无效。", ref)
  let compareValue: string | string[] | null = null
  if (value.value !== null && value.value !== undefined && operator !== null && isOperator(operator)) {
    compareValue = expressionValue(operator, value.value)
    if (compareValue === null) issue(issues, "INVALID_REFERENCE", "要求集快照的比较值无效。", ref)
  }
  const asOfRule = text(value.asOfRule)
  if (!(AS_OF_RULES as readonly string[]).includes(asOfRule)) issue(issues, "INVALID_REFERENCE", "要求集快照的判定时点规则无效。", ref)
  const addendumState = text(value.addendumState)
  if (!(ADDENDUM_STATES as readonly string[]).includes(addendumState)) issue(issues, "INVALID_REFERENCE", "要求集快照的补遗状态无效。", ref)
  const materialRelation = text(value.materialRelation)
  if (!materialRelation || materialRelation.length > 200) issue(issues, "INVALID_REFERENCE", "要求集快照缺少材料关系。", ref)
  const group = parseGroup(value.group, ref, issues)
  // Date requirements may use the task asOf as their comparison baseline when no
  // fixed date was set and asOfRule is "task_as_of" (see compare.ts / spec §4.3).
  const asOfDateBaseline = isVerificationFieldKey(field) && isOperator(operator) && compareValue === null &&
    asOfRule === "task_as_of" && DATE_OPERATORS.includes(operator)
  if (isVerificationFieldKey(field) && isOperator(operator) && compareValue === null && DATE_OPERATORS.includes(operator) && !asOfDateBaseline) {
    issue(issues, "INVALID_REFERENCE", "要求集快照的日期比较缺少判定时点。", ref)
  }
  const hasSingle = isVerificationFieldKey(field) && isOperator(operator) && (compareValue !== null || asOfDateBaseline)
  if (!hasSingle && !group) issue(issues, "INVALID_REFERENCE", "要求集快照缺少可比较表达式。", ref)
  if (hasSingle && group) issue(issues, "INVALID_REFERENCE", "要求集快照同时包含两种比较表达式。", ref)
  if (hasSingle && isOperator(operator) && DATE_OPERATORS.includes(operator) && VERIFICATION_FIELD_TYPES[field as never] !== "date") {
    issue(issues, "INVALID_REFERENCE", "要求集快照的日期运算与字段类型不符。", ref)
  }
  return {
    requirementId,
    subject,
    quote,
    source: { snapshotId, fragmentId },
    materialVersionId,
    nature: nature as RequirementSnapshot["nature"],
    field: isVerificationFieldKey(field) ? field : null,
    operator: isOperator(operator) ? operator : null,
    value: compareValue,
    asOfRule: (AS_OF_RULES as readonly string[]).includes(asOfRule) ? asOfRule as RequirementSnapshot["asOfRule"] : "not_applicable",
    addendumState: (ADDENDUM_STATES as readonly string[]).includes(addendumState) ? addendumState as RequirementSnapshot["addendumState"] : "none",
    materialRelation,
    group,
  }
}

function requirementFields(snapshot: RequirementSnapshot): string[] {
  const fields: string[] = []
  if (snapshot.group) for (const condition of snapshot.group.conditions) fields.push(condition.field)
  else if (snapshot.field) fields.push(snapshot.field)
  return fields
}

function inspectMaterials(raw: unknown, issues: Issue[]): MaterialSnapshot[] {
  if (!Array.isArray(raw) || !raw.length) { issue(issues, "INVALID_REFERENCE", "比较成果缺少材料版本清单。"); return [] }
  const materials: MaterialSnapshot[] = []
  const seen = new Set<string>()
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const ref = `materials[${index}]`
    if (!value || !exactKeys(value, MATERIAL_KEYS) || Object.keys(value).length !== MATERIAL_KEYS.length) {
      issue(issues, "INVALID_REFERENCE", "材料版本快照结构无效。", ref)
      continue
    }
    const materialId = identifier(value.materialId)
    const versionId = identifier(value.versionId)
    const sha256 = text(value.sha256)
    if (!materialId || !versionId || !SHA256_PATTERN.test(sha256) || seen.has(versionId)) {
      issue(issues, "INVALID_REFERENCE", "材料版本快照缺少归属或摘要。", ref)
      continue
    }
    seen.add(versionId)
    materials.push({ materialId, versionId, sha256 })
  }
  return materials
}

function inspectRecords(raw: unknown, requirementIds: Set<string>, issues: Issue[]): ExternalRecordSnapshot[] {
  if (!Array.isArray(raw) || raw.length > MAX_RECORDS) { issue(issues, "INVALID_RECORD", "外部核验记录清单无效。"); return [] }
  const records: ExternalRecordSnapshot[] = []
  const seenIds = new Set<string>()
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const ref = `records[${index}]`
    if (!value || !exactKeys(value, RECORD_KEYS) || Object.keys(value).length !== RECORD_KEYS.length) {
      issue(issues, "INVALID_RECORD", "外部核验记录结构无效。", ref)
      continue
    }
    const recordId = identifier(value.recordId)
    const sha256 = text(value.sha256)
    const requirementId = identifier(value.requirementId)
    const subject = text(value.subject)
    const certificateNo = text(value.certificateNo)
    const source = text(value.source)
    const queriedAt = text(value.queriedAt)
    const queryConditions = text(value.queryConditions)
    const conclusion = text(value.conclusion)
    const proofMaterialVersionId = identifier(value.proofMaterialVersionId)
    if (!recordId || seenIds.has(recordId) || !SHA256_PATTERN.test(sha256) || !requirementId || !requirementIds.has(requirementId) ||
      !subject || subject.length > 200 || !certificateNo || certificateNo.length > 128 ||
      !source || source.length > 500 || !queryConditions || queryConditions.length > 500 ||
      !proofMaterialVersionId || !(EXTERNAL_RECORD_CONCLUSIONS as readonly string[]).includes(conclusion) ||
      !queriedAt || queriedAt.length > 32 || !Number.isFinite(Date.parse(queriedAt))) {
      issue(issues, "INVALID_RECORD", "外部核验记录缺少必要字段或归属无效。", ref)
      continue
    }
    seenIds.add(recordId)
    records.push({
      recordId, sha256, requirementId, subject, certificateNo, source, queriedAt, queryConditions,
      conclusion: conclusion as ExternalRecordSnapshot["conclusion"], proofMaterialVersionId,
    })
  }
  return records
}

function inspectEvidence(raw: unknown, materialVersions: Set<string>, ref: string, issues: Issue[]): VerificationEvidence[] {
  if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE) { issue(issues, "INVALID_REFERENCE", "条目证据结构无效。", ref); return [] }
  const evidence: VerificationEvidence[] = []
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const evidenceRef = `${ref}.evidence[${index}]`
    if (!value || !exactKeys(value, EVIDENCE_KEYS) || Object.keys(value).length !== EVIDENCE_KEYS.length) {
      issue(issues, "INVALID_REFERENCE", "条目证据结构无效。", evidenceRef)
      continue
    }
    const fieldKey = value.fieldKey
    const valueText = text(value.valueText)
    const origin = text(value.origin)
    const subjectKey = identifier(value.subjectKey)
    const materialVersionId = identifier(value.materialVersionId)
    const confidence = value.confidence === null || value.confidence === undefined
      ? null
      : (typeof value.confidence === "number" && Number.isSafeInteger(value.confidence) && value.confidence >= 0 && value.confidence <= 100 ? value.confidence : undefined)
    if (!isVerificationFieldKey(fieldKey) || !valueText || valueText.length > 2000 || !subjectKey ||
      !["ocr", "manual", "material_text"].includes(origin) || !materialVersionId || !materialVersions.has(materialVersionId) ||
      confidence === undefined || (origin !== "ocr" && confidence !== null) ||
      typeof value.normalizedValue !== "string" || value.normalizedValue !== normalizeFieldValue(fieldKey, valueText)) {
      issue(issues, "INVALID_REFERENCE", "条目证据字段、置信度或归一化值无效。", evidenceRef)
      continue
    }
    evidence.push({ fieldKey, valueText, normalizedValue: value.normalizedValue, origin: origin as VerificationEvidence["origin"], confidence, subjectKey, materialVersionId })
  }
  return evidence
}

function inspectItems(raw: unknown, snapshots: RequirementSnapshot[], records: ExternalRecordSnapshot[], materialVersions: Set<string>, issues: Issue[]): VerificationItem[] {
  if (!Array.isArray(raw) || raw.length !== snapshots.length) {
    issue(issues, "INVALID_REFERENCE", "核验条目必须与要求集逐条对应。")
    return []
  }
  const byId = new Map(snapshots.map(snapshot => [snapshot.requirementId, snapshot]))
  const items: VerificationItem[] = []
  const seen = new Set<string>()
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const ref = `items[${index}]`
    if (!value || !exactKeys(value, ITEM_KEYS) || Object.keys(value).length !== ITEM_KEYS.length) {
      issue(issues, "INVALID_STRUCTURE", "核验条目结构无效。", ref)
      continue
    }
    const requirementId = identifier(value.requirementId)
    const snapshot = requirementId ? byId.get(requirementId) : undefined
    if (!snapshot || seen.has(requirementId)) { issue(issues, "INVALID_REFERENCE", "核验条目引用了未知或重复的要求。", ref); continue }
    seen.add(requirementId)
    const materialCheck = text(value.materialCheck)
    const externalCheck = text(value.externalCheck)
    const detail = typeof value.detail === "string" ? value.detail.trim() : ""
    if (!(MATERIAL_CHECK_STATUSES as readonly string[]).includes(materialCheck) ||
      !(EXTERNAL_CHECK_STATUSES as readonly string[]).includes(externalCheck) || !detail || detail.length > 2000) {
      issue(issues, "INVALID_STRUCTURE", "核验条目的两组状态或说明无效。", ref)
      continue
    }
    const evidence = inspectEvidence(value.evidence, materialVersions, ref, issues)
    const fields = requirementFields(snapshot)
    const requirementEvidence = evidence.filter(entry => fields.includes(entry.fieldKey))
    if (materialCheck === "满足材料要求" && !requirementEvidence.length) {
      issue(issues, "INVALID_REFERENCE", "材料检查通过但没有要求字段证据。", ref)
    }
    if (materialCheck === "材料缺失" && requirementEvidence.length) {
      issue(issues, "INVALID_REFERENCE", "材料缺失条目仍包含要求字段证据。", ref)
    }
    if ((materialCheck === "字段冲突" || materialCheck === "日期不满足") && !requirementEvidence.length) {
      issue(issues, "INVALID_REFERENCE", "字段冲突/日期不满足条目缺少证据。", ref)
    }
    const expectedExternal = mapExternalCheck(requirementId, snapshot.subject, evidence, records)
    if (expectedExternal !== externalCheck) {
      issue(issues, "INVALID_RECORD", "外部真实性状态与外部核验记录不一致。", ref)
    }
    items.push({
      requirementId,
      materialCheck: materialCheck as VerificationItem["materialCheck"],
      externalCheck: externalCheck as VerificationItem["externalCheck"],
      detail,
      evidence,
    })
  }
  if (seen.size !== snapshots.length) issue(issues, "INVALID_REFERENCE", "核验条目未覆盖全部要求。")
  return items
}

function expectedCoverage(items: VerificationItem[]): VerificationCoverage {
  const count = (predicate: (item: VerificationItem) => boolean) => items.filter(predicate).length
  return {
    requirements: items.length,
    compared: count(item => item.materialCheck !== "待确认"),
    materialSatisfied: count(item => item.materialCheck === "满足材料要求"),
    materialMissing: count(item => item.materialCheck === "材料缺失"),
    fieldConflict: count(item => item.materialCheck === "字段冲突"),
    dateUnsatisfied: count(item => item.materialCheck === "日期不满足"),
    pending: count(item => item.materialCheck === "待确认"),
    externalMatched: count(item => item.externalCheck === "人工查询记录匹配"),
    externalUnverified: count(item => item.externalCheck === "未核验"),
    externalOther: count(item => !["人工查询记录匹配", "未核验"].includes(item.externalCheck)),
  }
}

function inspectCoverage(raw: unknown, items: VerificationItem[], issues: Issue[]): VerificationCoverage | null {
  const value = record(raw)
  if (!value || !exactKeys(value, COVERAGE_KEYS) || Object.keys(value).length !== COVERAGE_KEYS.length) {
    issue(issues, "INVALID_STRUCTURE", "覆盖统计结构无效。")
    return null
  }
  const coverage = {} as VerificationCoverage
  for (const key of COVERAGE_KEYS) {
    const count = value[key]
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      issue(issues, "INVALID_STRUCTURE", "覆盖统计不是有效非负整数。")
      return null
    }
    coverage[key as keyof VerificationCoverage] = Number(count)
  }
  const expected = expectedCoverage(items)
  for (const key of COVERAGE_KEYS) {
    if (coverage[key as keyof VerificationCoverage] !== expected[key as keyof VerificationCoverage]) {
      issue(issues, "COVERAGE_INCONSISTENT", "覆盖统计与核验条目不一致。", key)
    }
  }
  return coverage
}

function inspectUnfinished(raw: unknown, items: VerificationItem[], requirementIds: Set<string>, issues: Issue[]): VerificationUnfinished[] {
  if (!Array.isArray(raw)) { issue(issues, "INVALID_STRUCTURE", "未完成清单结构无效。"); return [] }
  const unfinished: VerificationUnfinished[] = []
  const seen = new Set<string>()
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const requirementId = identifier(value?.requirementId)
    const reason = text(value?.reason)
    if (!value || !exactKeys(value, UNFINISHED_KEYS) || Object.keys(value).length !== UNFINISHED_KEYS.length ||
      !requirementId || !requirementIds.has(requirementId) || seen.has(requirementId) || !reason || reason.length > 500) {
      issue(issues, "INVALID_REFERENCE", "未完成清单条目无效。", `unfinished[${index}]`)
      continue
    }
    seen.add(requirementId)
    unfinished.push({ requirementId, reason })
  }
  for (const item of items) {
    const requiresAction = item.materialCheck === "待确认" || item.externalCheck !== "人工查询记录匹配"
    if (requiresAction && !seen.has(item.requirementId)) {
      issue(issues, "INVALID_REFERENCE", "未完成清单缺少必要事项。", item.requirementId)
    }
  }
  return unfinished
}

/** Structural inspection shared by the validator (exported for tests and the service). */
export function inspectVerificationValue(value: unknown): { value: BidVerificationValue | null; issues: Issue[] } {
  const issues: Issue[] = []
  const root = record(value)
  if (!root || !exactKeys(root, ROOT_KEYS)) return { value: null, issues: [{ code: "INVALID_STRUCTURE", message: "核验成果不是有效对象。" }] }
  if (root.schemaVersion !== 1) issue(issues, "INVALID_STRUCTURE", "核验成果版本不受支持。")
  const status = text(root.status)
  if (status !== "success" && status !== "partial") issue(issues, "INVALID_STRUCTURE", "核验成果执行状态无效。")
  const asOf = text(root.asOf)
  if (!DAY_PATTERN.test(asOf) || normalizeDateValue(asOf) !== asOf) issue(issues, "INVALID_STRUCTURE", "核验成果缺少有效判定日期。")

  const requirementSet = record(root.requirementSet)
  if (!requirementSet || !exactKeys(requirementSet, SET_KEYS)) { issue(issues, "INVALID_REFERENCE", "核验成果缺少要求集快照。"); return { value: null, issues } }
  const setId = identifier(requirementSet.id)
  const setVersionId = identifier(requirementSet.versionId)
  const setSha = text(requirementSet.sha256)
  if (!setId || !setVersionId || !SHA256_PATTERN.test(setSha)) issue(issues, "INVALID_REFERENCE", "要求集快照缺少编号、版本或摘要。")
  if (!Array.isArray(requirementSet.requirements) || !requirementSet.requirements.length) {
    issue(issues, "INVALID_REFERENCE", "要求集快照缺少要求清单。")
    return { value: null, issues }
  }
  if (requirementSet.requirements.length > MAX_REQUIREMENTS) {
    issue(issues, "INVALID_REFERENCE", `要求集快照超过数量上限（最多 ${MAX_REQUIREMENTS} 条）。`)
    return { value: null, issues }
  }
  const snapshots: RequirementSnapshot[] = []
  const seenIds = new Set<string>()
  for (const [index, raw] of requirementSet.requirements.entries()) {
    const snapshot = inspectSnapshot(raw, index, issues, seenIds)
    if (snapshot) snapshots.push(snapshot)
  }
  const materials = inspectMaterials(root.materials, issues)
  const materialVersions = new Set(materials.map(material => material.versionId))
  const records = inspectRecords(root.records, seenIds, issues)
  const items = inspectItems(root.items, snapshots, records, materialVersions, issues)
  const coverage = inspectCoverage(root.coverage, items, issues)
  const unfinished = inspectUnfinished(root.unfinished, items, seenIds, issues)
  const warnings = Array.isArray(root.warnings) ? root.warnings.filter((item): item is string => typeof item === "string") : []
  if (!Array.isArray(root.warnings) || warnings.length !== (root.warnings as unknown[]).length) issue(issues, "INVALID_STRUCTURE", "核验成果提示记录无效。")
  const errors: Array<{ code: string; message: string }> = []
  if (!Array.isArray(root.errors)) issue(issues, "INVALID_STRUCTURE", "核验成果错误记录无效。")
  else for (const item of root.errors) {
    const error = record(item)
    if (!error || !exactKeys(error, ["code", "message"]) || !text(error.code) || !text(error.message)) { issue(issues, "INVALID_STRUCTURE", "核验成果错误记录无效。"); continue }
    errors.push({ code: text(error.code).slice(0, 64), message: text(error.message).slice(0, 500) })
  }

  const partial = items.some(item => item.materialCheck === "待确认")
  if ((status === "partial") !== partial) issue(issues, "COVERAGE_INCONSISTENT", "执行状态与待确认条目不一致。")
  if (issues.length) return { value: null, issues }
  return {
    value: {
      schemaVersion: 1,
      status: status as BidVerificationValue["status"],
      asOf,
      requirementSet: { id: setId, versionId: setVersionId, sha256: setSha, requirements: snapshots },
      materials,
      records,
      items,
      coverage: coverage as VerificationCoverage,
      unfinished,
      warnings,
      errors,
    },
    issues,
  }
}

/** Server-owned result validator for `bid-verification`. */
export const bidVerificationResultValidator: ResultValidator = async value => {
  const inspected = inspectVerificationValue(value)
  if (!inspected.value) return { status: "invalid", issues: inspected.issues }
  return { status: inspected.value.status === "partial" ? "partial" : "valid", issues: [] }
}
