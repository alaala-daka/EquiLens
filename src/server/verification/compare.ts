import {
  DATE_OPERATORS, type ComparisonOperator, type ExternalCheckStatus, type MaterialCheckStatus,
  type RequirementCondition, type RequirementSnapshot, type VerificationCoverage, type VerificationEvidence,
  type VerificationItem, type VerificationUnfinished, type ExternalRecordSnapshot,
} from "../../lib/business/verification-types"
import {
  VERIFICATION_FIELD_LABELS, VERIFICATION_FIELD_TYPES, isVerificationFieldKey,
  normalizeFieldValue, type VerificationFieldKey,
} from "../../lib/business/verification-fields"
import type { VerificationFieldValue } from "./field-source"

/**
 * C4-VERIFY deterministic comparison engine (spec 01 §4.3, plan §4.7/§5).
 *
 * Pure function: no database, model, clock, randomness or floating point. It
 * turns confirmed requirements plus current project field values plus the pinned
 * manual verification records into two independent per-requirement statuses:
 *
 * - 材料检查: 满足材料要求 / 材料缺失 / 字段冲突 / 日期不满足 / 待确认
 * - 外部真实性: 未核验 / 待人工核验 / 人工查询记录匹配 / 记录冲突 / 未查到 / 查询失败
 *
 * Safety rules frozen here:
 * - a requirement that cannot be expressed deterministically or whose addendum
 *   is conflicting is 待确认 (never satisfied);
 * - an AND group must be satisfied by one subject's field values together, so a
 *   name from one certificate and a number from another cannot fake a pass;
 * - unmatched/absent evidence is 材料缺失 or 待确认, never a pass;
 * - only a matched manual record whose subject and certificate number match the
 *   compared evidence becomes 人工查询记录匹配; every other external state stays
 *   unresolved and the two dimensions never overwrite each other;
 * - document text/field values are data: instruction-like content cannot create
 *   a satisfied status.
 */
export const COMPARE_AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type CompareInput = {
  /** Confirmed, comparison-ready requirement snapshots embedded in the result value. */
  requirements: RequirementSnapshot[]
  /** Current field values for the compared material versions in this project. */
  fieldValues: VerificationFieldValue[]
  /** Exactly the pinned manual records from the task manifest. */
  records: ExternalRecordSnapshot[]
  /** Explicit judgment day; never "today". */
  asOf: string
}

export type CompareOutput = {
  status: "success" | "partial"
  items: VerificationItem[]
  coverage: VerificationCoverage
  unfinished: VerificationUnfinished[]
  warnings: string[]
  errors: Array<{ code: string; message: string }>
}

type Evidence = VerificationEvidence

const MAX_EVIDENCE = 50
const MAX_DETAIL = 1900
const MAX_REASON = 280
/** OCR evidence below this confidence is 待核实 and never satisfies a requirement. */
export const MIN_OCR_CONFIDENCE = 80

/** Locale-independent code-unit comparison so canonical output is platform-stable. */
function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeConfidence(origin: Evidence["origin"], confidence: number | null): number | null {
  if (origin !== "ocr") return null
  return typeof confidence === "number" && Number.isSafeInteger(confidence) && confidence >= 0 && confidence <= 100 ? confidence : null
}

function normalizeEvidence(input: VerificationFieldValue): Evidence | null {
  if (!isVerificationFieldKey(input.fieldKey)) return null
  if (typeof input.valueText !== "string" || !input.valueText.trim()) return null
  if (typeof input.subjectKey !== "string" || !input.subjectKey.trim()) return null
  if (typeof input.versionId !== "string" || !input.versionId.trim()) return null
  if (!["ocr", "manual", "material_text"].includes(input.origin)) return null
  return {
    fieldKey: input.fieldKey,
    valueText: input.valueText,
    normalizedValue: normalizeFieldValue(input.fieldKey, input.valueText),
    origin: input.origin,
    confidence: normalizeConfidence(input.origin, input.confidence),
    subjectKey: input.subjectKey,
    materialVersionId: input.versionId,
  }
}

function evidenceKey(value: Evidence): string {
  return `${value.subjectKey}\u0000${value.fieldKey}\u0000${value.valueText}\u0000${value.materialVersionId}\u0000${value.origin}\u0000${value.confidence ?? ""}`
}

function evidenceOrder(left: Evidence, right: Evidence): number {
  return codeUnitCompare(evidenceKey(left), evidenceKey(right))
}

function normalizedList(input: VerificationFieldValue[]): Evidence[] {
  return input.map(normalizeEvidence).filter((value): value is Evidence => value !== null).sort(evidenceOrder)
}

function uniqueEvidence(values: Evidence[]): Evidence[] {
  const seen = new Set<string>()
  const unique: Evidence[] = []
  for (const value of [...values].sort(evidenceOrder)) {
    const key = evidenceKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(value)
  }
  return unique.slice(0, MAX_EVIDENCE)
}

/** Low-confidence OCR evidence can never establish a material pass. */
function isLowConfidence(value: Evidence): boolean {
  return value.origin === "ocr" && value.confidence !== null && value.confidence < MIN_OCR_CONFIDENCE
}

/** A condition is usable only with a shared-vocabulary field and a known operator. */
function validCondition(condition: RequirementCondition): boolean {
  if (!condition || typeof condition !== "object") return false
  // Single flat condition only: nested groups or extra properties are not expressible.
  const keys = Object.keys(condition as unknown as Record<string, unknown>)
  if (keys.some(key => !["field", "operator", "value"].includes(key))) return false
  if (!isVerificationFieldKey(condition.field)) return false
  const operators: readonly ComparisonOperator[] = ["eq", "neq", "in", "not_in", "lte", "gte", "on_or_before", "on_or_after", "contains"]
  if (!operators.includes(condition.operator)) return false
  if (condition.operator === "in" || condition.operator === "not_in") {
    if (!Array.isArray(condition.value) || !condition.value.length || condition.value.some(item => typeof item !== "string")) return false
  } else if (typeof condition.value !== "string" || !condition.value.trim()) return false
  return true
}

/** Date operators only apply to date-typed fields; the validator enforces the same rule. */
function dateOperatorCompatible(condition: RequirementCondition): boolean {
  if (!DATE_OPERATORS.includes(condition.operator)) return true
  return VERIFICATION_FIELD_TYPES[condition.field] === "date"
}

function normalizedExpected(condition: RequirementCondition): string[] {
  const raw = Array.isArray(condition.value) ? condition.value : [condition.value]
  return raw.map(value => normalizeFieldValue(condition.field, value)).filter(Boolean)
}

function compareNormalized(condition: RequirementCondition, actual: string): boolean {
  const expected = normalizedExpected(condition)
  switch (condition.operator) {
    case "eq": return expected.length === 1 && actual === expected[0]
    case "neq": return expected.length === 1 && actual !== expected[0]
    case "in": return expected.includes(actual)
    case "not_in": return expected.length > 0 && !expected.includes(actual)
    case "contains": return expected.length === 1 && actual.includes(expected[0])
    case "lte":
    case "on_or_before": return expected.length === 1 && isDay(actual) && isDay(expected[0]) && actual <= expected[0]
    case "gte":
    case "on_or_after": return expected.length === 1 && isDay(actual) && isDay(expected[0]) && actual >= expected[0]
    default: return false
  }
}

function isDay(value: string): boolean {
  return COMPARE_AS_OF_PATTERN.test(value)
}

type ConditionOutcome = "satisfied" | "violated" | "missing" | "unconfirmed"

/**
 * Evaluate one condition. Only high-confidence evidence can satisfy it:
 * - a high-confidence matching value satisfies;
 * - otherwise, if only low-confidence OCR evidence would satisfy, the outcome is
 *   unconfirmed (字段待核实), never satisfied and never a hard conflict;
 * - a usable (high-confidence/manual) value that fails is a conflict;
 * - no value at all is missing.
 */
function evaluateCondition(condition: RequirementCondition, evidence: Evidence[]): ConditionOutcome {
  const matching = evidence.filter(value => value.fieldKey === condition.field)
  if (!matching.length) return "missing"
  if (matching.some(value => !isLowConfidence(value) && compareNormalized(condition, value.normalizedValue))) return "satisfied"
  if (matching.some(value => isLowConfidence(value) && compareNormalized(condition, value.normalizedValue))) return "unconfirmed"
  if (matching.some(value => !isLowConfidence(value))) return "violated"
  return "unconfirmed"
}

function fieldsOf(requirement: RequirementSnapshot): VerificationFieldKey[] {
  const fields: VerificationFieldKey[] = []
  const add = (field: VerificationFieldKey | null) => {
    if (field && isVerificationFieldKey(field) && !fields.includes(field)) fields.push(field)
  }
  if (requirement.group) {
    for (const condition of requirement.group.conditions ?? []) add(condition?.field ?? null)
  } else {
    add(requirement.field)
  }
  return fields
}

/**
 * Build the comparable conditions of a requirement, resolving the 判定时点:
 * a date operator with no fixed comparison date and `asOfRule: "task_as_of"`
 * compares the field date against the task's explicit `asOf` day (never "today");
 * `not_applicable` never supplies a baseline, so such a requirement is not
 * expressible and falls back to 待确认 rather than being guessed.
 */
function conditionsOf(requirement: RequirementSnapshot, asOf: string): RequirementCondition[] | null {
  if (requirement.group) {
    const group = requirement.group
    if (!group || typeof group !== "object" || (group.operator !== "and" && group.operator !== "or")) return null
    if (!Array.isArray(group.conditions) || !group.conditions.length || group.conditions.length > 10) return null
    // Single level only: a nested group inside a condition is not representable.
    if (group.conditions.some(condition => !condition || typeof condition !== "object" ||
      !validCondition(condition) || !dateOperatorCompatible(condition) || "group" in (condition as object))) return null
    return group.conditions
  }
  if (requirement.field === null || requirement.operator === null) return null
  const asOfBaseline = requirement.value === null && requirement.asOfRule === "task_as_of" &&
    DATE_OPERATORS.includes(requirement.operator)
  if (requirement.value === null && !asOfBaseline) return null
  const condition: RequirementCondition = {
    field: requirement.field as VerificationFieldKey,
    operator: requirement.operator,
    value: requirement.value ?? asOf,
  }
  if (!validCondition(condition) || !dateOperatorCompatible(condition)) return null
  return [condition]
}

function label(condition: RequirementCondition): string {
  return isVerificationFieldKey(condition.field) ? VERIFICATION_FIELD_LABELS[condition.field] : "字段"
}

function expectedText(condition: RequirementCondition): string {
  return (Array.isArray(condition.value) ? condition.value : [condition.value]).join("、").slice(0, 120)
}

function actualText(condition: RequirementCondition, evidence: Evidence[]): string {
  const values = evidence.filter(value => value.fieldKey === condition.field).map(value => value.valueText)
  if (!values.length) return "无"
  return [...new Set(values)].join("、").slice(0, 160)
}

function isDateCondition(condition: RequirementCondition): boolean {
  return DATE_OPERATORS.includes(condition.operator) || VERIFICATION_FIELD_TYPES[condition.field] === "date"
}

function violatedClassification(conditions: RequirementCondition[]): "日期不满足" | "字段冲突" {
  return conditions.some(isDateCondition) ? "日期不满足" : "字段冲突"
}

function satisfiedDetail(conditions: RequirementCondition[]): string {
  return `材料检查：满足材料要求（${[...new Set(conditions.map(label))].join("、")}）。`
}

function missingDetail(conditions: RequirementCondition[]): string {
  return `材料检查：材料缺失（缺少${[...new Set(conditions.map(label))].join("、")}字段值）。`
}

function unconfirmedDetail(conditions: RequirementCondition[]): string {
  return `材料检查：待确认（${[...new Set(conditions.map(label))].join("、")} OCR 识别置信度不足，字段待核实）。`
}

function violatedDetail(conditions: RequirementCondition[], evidence: Evidence[], asOf: string): string {
  const condition = conditions[0]
  const status = violatedClassification(conditions)
  if (status === "日期不满足") {
    return `材料检查：日期不满足（${label(condition)}要求 ${condition.operator} ${expectedText(condition)}，材料值「${actualText(condition, evidence)}」，判定日期 ${asOf}）。`
  }
  return `材料检查：字段冲突（${label(condition)}要求「${expectedText(condition)}」，材料值「${actualText(condition, evidence)}」）。`
}

type MaterialEvaluation = { status: MaterialCheckStatus; detail: string; evidence: Evidence[] }

function evaluateMaterial(requirement: RequirementSnapshot, evidence: Evidence[], asOf: string): MaterialEvaluation {
  const scope = evidence.filter(value => fieldsOf(requirement).includes(value.fieldKey))
  if (requirement.addendumState === "conflict") {
    return { status: "待确认", detail: "材料检查：待确认（补遗与原招标文件冲突，须人工确认适用版本）。", evidence: uniqueEvidence(scope) }
  }
  const conditions = conditionsOf(requirement, asOf)
  if (!conditions) {
    return { status: "待确认", detail: "材料检查：待确认（要求无法以确定字段与运算表达，转人工判断）。", evidence: uniqueEvidence(scope) }
  }
  if (requirement.group && requirement.group.operator === "and") {
    const subjects = [...new Set(scope.map(value => value.subjectKey))].sort(codeUnitCompare)
    const globalOutcomes = conditions.map(condition => evaluateCondition(condition, scope))
    let sawViolated = false
    let sawUnconfirmed = false
    for (const subject of subjects) {
      const own = scope.filter(value => value.subjectKey === subject)
      const outcomes = conditions.map(condition => evaluateCondition(condition, own))
      if (outcomes.every(outcome => outcome === "satisfied")) {
        return { status: "满足材料要求", detail: satisfiedDetail(conditions), evidence: uniqueEvidence(own) }
      }
      if (outcomes.includes("violated")) sawViolated = true
      else if (outcomes.includes("unconfirmed")) sawUnconfirmed = true
    }
    if (globalOutcomes.every(outcome => outcome === "missing")) {
      return { status: "材料缺失", detail: missingDetail(conditions), evidence: [] }
    }
    if (sawViolated) {
      const violated = conditions.filter((condition, index) => globalOutcomes[index] === "violated")
      return { status: violatedClassification(violated.length ? violated : conditions), detail: violatedDetail(violated.length ? violated : conditions, evidence, asOf), evidence: uniqueEvidence(scope) }
    }
    if (sawUnconfirmed || globalOutcomes.includes("unconfirmed")) {
      return { status: "待确认", detail: unconfirmedDetail(conditions), evidence: uniqueEvidence(scope) }
    }
    // No single subject satisfies every condition and no violation could be
    // established: the mixed evidence cannot confirm the requirement.
    return { status: "待确认", detail: unconfirmedDetail(conditions), evidence: uniqueEvidence(scope) }
  }
  const outcomes = conditions.map(condition => evaluateCondition(condition, scope))
  if (!requirement.group) {
    const outcome = outcomes[0]
    if (outcome === "satisfied") return { status: "满足材料要求", detail: satisfiedDetail(conditions), evidence: uniqueEvidence(scope) }
    if (outcome === "missing") return { status: "材料缺失", detail: missingDetail(conditions), evidence: [] }
    if (outcome === "unconfirmed") return { status: "待确认", detail: unconfirmedDetail(conditions), evidence: uniqueEvidence(scope) }
    return { status: violatedClassification(conditions), detail: violatedDetail(conditions, evidence, asOf), evidence: uniqueEvidence(scope) }
  }
  // OR group: any high-confidence satisfied condition confirms the requirement.
  if (outcomes.includes("satisfied")) {
    const satisfying = conditions.filter((condition, index) => outcomes[index] === "satisfied")
    return { status: "满足材料要求", detail: satisfiedDetail(satisfying), evidence: uniqueEvidence(scope.filter(value => satisfying.some(condition => condition.field === value.fieldKey))) }
  }
  if (outcomes.every(outcome => outcome === "missing")) {
    return { status: "材料缺失", detail: missingDetail(conditions), evidence: [] }
  }
  if (outcomes.includes("unconfirmed")) {
    return { status: "待确认", detail: unconfirmedDetail(conditions), evidence: uniqueEvidence(scope) }
  }
  const violated = conditions.filter((condition, index) => outcomes[index] === "violated")
  return { status: violatedClassification(violated), detail: violatedDetail(violated, evidence, asOf), evidence: uniqueEvidence(scope) }
}

export function recordMatchesEvidence(record: ExternalRecordSnapshot, evidence: Evidence[]): boolean {
  const subject = normalizeFieldValue("subject_name", record.subject)
  const number = normalizeFieldValue("certificate_number", record.certificateNo)
  if (!subject || !number) return false
  // Subject name and certificate number must belong to the SAME compared subject;
  // a name from one certificate plus a number from another is not a match.
  const bySubject = new Map<string, { names: string[]; numbers: string[] }>()
  const entry = (subjectKey: string) => {
    const existing = bySubject.get(subjectKey) ?? { names: [], numbers: [] }
    bySubject.set(subjectKey, existing)
    return existing
  }
  for (const value of evidence) {
    if (value.fieldKey === "subject_name" || value.fieldKey === "holder_name") entry(value.subjectKey).names.push(value.normalizedValue)
    if (value.fieldKey === "certificate_number" || value.fieldKey === "unified_social_credit_code" || value.fieldKey === "holder_id_number") {
      entry(value.subjectKey).numbers.push(value.normalizedValue)
    }
  }
  for (const group of bySubject.values()) {
    if (group.names.includes(subject) && group.numbers.includes(number)) return true
  }
  return false
}

const externalReason: Record<ExternalCheckStatus, string> = {
  "未核验": "尚无人工查询记录",
  "待人工核验": "人工查询记录待核验",
  "人工查询记录匹配": "存在与比较证据一致的人工查询记录",
  "记录冲突": "人工查询记录与比较证据或相互之间存在冲突",
  "未查到": "人工查询未查到",
  "查询失败": "人工查询失败",
}

function recordRequirementId(record: ExternalRecordSnapshot): string {
  return typeof (record as { requirementId?: unknown }).requirementId === "string"
    ? String((record as { requirementId: string }).requirementId) : ""
}

const IDENTIFIER_FIELDS = ["subject_name", "holder_name", "certificate_number", "unified_social_credit_code", "holder_id_number"] as const

/** A matched record must bind to the requirement's 义务主体, not only to the material evidence. */
function matchesRequirementSubject(record: ExternalRecordSnapshot, requirementSubject: string): boolean {
  const recordSubject = normalizeFieldValue("subject_name", record.subject)
  const subject = normalizeFieldValue("subject_name", requirementSubject)
  return !!recordSubject && !!subject && recordSubject === subject
}

/**
 * Map the pinned manual records of one requirement to its 外部真实性 status.
 * Only when EVERY matched record's subject equals the requirement's 义务主体 AND
 * its subject/certificate number equal the compared evidence does the status
 * become a match; any conflicting or unverifiable matched record keeps the
 * status a conflict. 未核验/未查到/查询失败/待人工核验 never become a pass.
 */
export function mapExternalCheck(requirementId: string, requirementSubject: string, evidence: Evidence[], records: ExternalRecordSnapshot[]): ExternalCheckStatus {
  const recordsForRequirement = records.filter(record => recordRequirementId(record) === requirementId)
  if (!recordsForRequirement.length) return "未核验"
  if (recordsForRequirement.some(record => record.conclusion === "conflict")) return "记录冲突"
  const matched = recordsForRequirement.filter(record => record.conclusion === "matched")
  if (matched.length) {
    return matched.every(record => matchesRequirementSubject(record, requirementSubject) && recordMatchesEvidence(record, evidence))
      ? "人工查询记录匹配" : "记录冲突"
  }
  if (recordsForRequirement.some(record => record.conclusion === "pending")) return "待人工核验"
  if (recordsForRequirement.some(record => record.conclusion === "not_found")) return "未查到"
  if (recordsForRequirement.some(record => record.conclusion === "query_failed")) return "查询失败"
  return "未核验"
}

function coverageOf(items: VerificationItem[]): VerificationCoverage {
  const count = (predicate: (item: VerificationItem) => boolean) => items.filter(predicate).length
  const coverage: VerificationCoverage = {
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
  return coverage
}

function unfinishedOf(items: VerificationItem[]): VerificationUnfinished[] {
  const unfinished: VerificationUnfinished[] = []
  for (const item of items) {
    const parts: string[] = []
    if (item.materialCheck === "待确认") parts.push("材料检查待确认")
    if (item.externalCheck !== "人工查询记录匹配") parts.push(`外部真实性${item.externalCheck}`)
    if (!parts.length) continue
    unfinished.push({ requirementId: item.requirementId, reason: parts.join("；").slice(0, MAX_REASON) })
  }
  return unfinished
}

export function compareRequirements(input: CompareInput): CompareOutput {
  const evidence = normalizedList(input.fieldValues)
  const records = Array.isArray(input.records) ? input.records : []
  // Subject/certificate identifiers are always embedded with every item so an
  // external-record match (and the validator re-derivation) can prove that the
  // queried subject is the compared material subject.
  const identifiers = evidence.filter(value => (IDENTIFIER_FIELDS as readonly string[]).includes(value.fieldKey))
  const items: VerificationItem[] = input.requirements.map(requirement => {
    const material = evaluateMaterial(requirement, evidence, input.asOf)
    const itemEvidence = uniqueEvidence([...material.evidence, ...identifiers])
    const externalCheck = mapExternalCheck(requirement.requirementId, requirement.subject, itemEvidence, records)
    const detail = `${material.detail}外部真实性：${externalCheck}（${externalReason[externalCheck]}）。`.slice(0, MAX_DETAIL)
    return {
      requirementId: requirement.requirementId,
      materialCheck: material.status,
      externalCheck,
      detail,
      evidence: itemEvidence,
    }
  })
  const warnings: string[] = []
  if (input.requirements.some(requirement => requirement.addendumState === "conflict")) {
    warnings.push("存在补遗冲突的要求，比较未自动采用任何修订版本；相关要求待人工确认。")
  }
  return {
    status: items.some(item => item.materialCheck === "待确认") ? "partial" : "success",
    items,
    coverage: coverageOf(items),
    unfinished: unfinishedOf(items),
    warnings,
    errors: [],
  }
}
