import {
  ADDENDUM_STATES, AS_OF_RULES, COMPARISON_OPERATORS, DATE_OPERATORS, LIST_OPERATORS,
  REQUIREMENT_NATURES, REQUIREMENT_NATURE_PENDING, type ComparisonOperator, type RequirementCondition,
  type RequirementGroup, type RequirementSetValue, type RequirementSnapshot,
  type VerificationRequirement,
} from "../../lib/business/verification-types"
import {
  VERIFICATION_FIELD_TYPES, isVerificationFieldKey, quotesMatch, type VerificationFieldKey,
} from "../../lib/business/verification-fields"
import type { ResultValidator } from "../results/validation"
import { REQUIREMENT_ID_PATTERN, VerificationError, record, text } from "./types"

/**
 * C4-VERIFY requirement-set authority (spec 01 §4.3/§8.2.3, plan §4.7).
 *
 * `bidRequirementSetValidator` re-checks a saved immutable value from scratch:
 * structure, shared-vocabulary fields, known nature/operator, single-level
 * AND/OR groups, addendum state and the confirmed/pending split. It never turns
 * an unconfirmed requirement into a veto and never returns `valid` while any
 * requirement is still pending. Verbatim source verification is done by
 * `VerificationService.saveRequirementSet` (which re-reads every snapshot and
 * fragment) and by `ResultService`'s recorded-source check — the validator
 * deliberately performs no database access.
 *
 * `parseRequirementCandidates` only normalizes model candidates; every mapped
 * requirement stays `pending` so a model can never auto-confirm a requirement or
 * create a veto condition. Quotes must map verbatim (whitespace-normalized) to a
 * selected project fragment or the candidate is rejected and recorded.
 */
type Issue = { code: string; message: string; ref?: string }

const MAX_REASON = 500
const MAX_GROUP_CONDITIONS = 10
/** Server-owned save cap; also enforced by the validator so a stored value cannot exceed it. */
export const MAX_REQUIREMENTS = 200

function issue(issues: Issue[], code: string, message: string, ref?: string): void {
  issues.push(ref ? { code, message, ref } : { code, message })
}

function isOperator(value: unknown): value is ComparisonOperator {
  return typeof value === "string" && (COMPARISON_OPERATORS as readonly string[]).includes(value)
}

function valueShape(operator: ComparisonOperator, value: unknown): string | string[] | null {
  if (LIST_OPERATORS.includes(operator)) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null
    const items = value.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    return items.length === value.length && items.every(item => item.length <= 200) ? items : null
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 500 ? trimmed : null
}

function validConditionValue(condition: RequirementCondition): boolean {
  if (LIST_OPERATORS.includes(condition.operator)) {
    if (!Array.isArray(condition.value) || !condition.value.length) return false
    if (condition.value.some(item => typeof item !== "string" || !item.trim())) return false
  } else if (typeof condition.value !== "string" || !condition.value.trim()) return false
  if (DATE_OPERATORS.includes(condition.operator) && VERIFICATION_FIELD_TYPES[condition.field] !== "date") return false
  return true
}

function inspectGroup(raw: unknown, ref: string, issues: Issue[]): RequirementGroup | null {
  if (raw === null || raw === undefined) return null
  const group = record(raw)
  if (!group) { issue(issues, "INVALID_GROUP", "要求分组结构无效。", ref); return null }
  if (Object.keys(group).some(key => !["operator", "conditions"].includes(key))) {
    issue(issues, "UNSUPPORTED_GROUP", "不支持嵌套或未知的分组结构。", ref)
    return null
  }
  if (group.operator !== "and" && group.operator !== "or") {
    issue(issues, "INVALID_GROUP", "要求分组的逻辑运算无效。", ref)
    return null
  }
  if (!Array.isArray(group.conditions) || group.conditions.length < 1 || group.conditions.length > MAX_GROUP_CONDITIONS) {
    issue(issues, "INVALID_GROUP", "要求分组缺少有效条件。", ref)
    return null
  }
  const conditions: RequirementCondition[] = []
  for (const [index, rawCondition] of group.conditions.entries()) {
    const conditionRef = `${ref}.conditions[${index}]`
    const condition = record(rawCondition)
    if (!condition || Object.keys(condition).some(key => !["field", "operator", "value"].includes(key))) {
      issue(issues, "UNSUPPORTED_GROUP", "不支持嵌套或未知的条件结构。", conditionRef)
      return null
    }
    if (!isVerificationFieldKey(condition.field)) { issue(issues, "INVALID_FIELD", "条件的字段不在核验词表内。", conditionRef); return null }
    if (!isOperator(condition.operator)) { issue(issues, "INVALID_OPERATOR", "条件的比较运算符无效。", conditionRef); return null }
    const value = valueShape(condition.operator, condition.value)
    if (value === null) { issue(issues, "INVALID_VALUE", "条件的比较值无效。", conditionRef); return null }
    const parsed: RequirementCondition = { field: condition.field, operator: condition.operator, value }
    if (!validConditionValue(parsed)) { issue(issues, "INVALID_OPERATOR", "比较运算符与字段类型不匹配。", conditionRef); return null }
    conditions.push(parsed)
  }
  return { operator: group.operator, conditions }
}

function inspectAddendum(raw: unknown, ref: string, issues: Issue[]): { state: RequirementSetValue["requirements"][number]["addendum"]["state"]; note: string } {
  const addendum = record(raw)
  if (!addendum || !(ADDENDUM_STATES as readonly unknown[]).includes(addendum.state)) {
    issue(issues, "INVALID_ADDENDUM", "补遗状态无效。", ref)
    return { state: "none", note: "" }
  }
  if (typeof addendum.note !== "string" || addendum.note.length > MAX_REASON) {
    issue(issues, "INVALID_ADDENDUM", "补遗说明无效。", ref)
    return { state: "none", note: "" }
  }
  return { state: addendum.state as RequirementSetValue["requirements"][number]["addendum"]["state"], note: addendum.note.trim() }
}

function inspectRequirement(raw: unknown, index: number, issues: Issue[], seenIds: Set<string>): VerificationRequirement | null {
  const ref = `requirements[${index}]`
  const value = record(raw)
  if (!value) { issue(issues, "INVALID_STRUCTURE", "要求条目结构无效。", ref); return null }
  const requirementId = text(value.requirementId)
  if (!REQUIREMENT_ID_PATTERN.test(requirementId)) issue(issues, "INVALID_STRUCTURE", "要求编号无效。", ref)
  else if (seenIds.has(requirementId)) issue(issues, "DUPLICATE_REQUIREMENT", "要求编号重复。", ref)
  else seenIds.add(requirementId)
  const subject = text(value.subject)
  if (!subject || subject.length > 200) issue(issues, "INVALID_STRUCTURE", "要求缺少有效的义务主体。", ref)
  const quote = text(value.quote)
  if (!quote || quote.length > 2000) issue(issues, "INVALID_SOURCE", "要求缺少有效的原文引文。", ref)
  const materialVersionId = text(value.materialVersionId)
  if (!materialVersionId || materialVersionId.length > 64) issue(issues, "INVALID_SOURCE", "要求缺少来源材料版本。", ref)
  const source = record(value.source)
  const snapshotId = text(source?.snapshotId)
  const fragmentId = text(source?.fragmentId)
  if (!source || !snapshotId || snapshotId.length > 64 || !fragmentId || fragmentId.length > 64) {
    issue(issues, "INVALID_SOURCE", "要求缺少解析快照或原文片段引用。", ref)
  }
  const nature = text(value.nature)
  if (!(REQUIREMENT_NATURES as readonly string[]).includes(nature) && nature !== REQUIREMENT_NATURE_PENDING) {
    issue(issues, "INVALID_NATURE", "要求的性质无效。", ref)
  }
  const field = value.field ?? null
  if (field !== null && !isVerificationFieldKey(field)) issue(issues, "INVALID_FIELD", "要求的字段不在核验词表内。", ref)
  const operator = value.operator ?? null
  if (operator !== null && !isOperator(operator)) issue(issues, "INVALID_OPERATOR", "要求的比较运算符无效。", ref)
  let compareValue: string | string[] | null = null
  if (value.value !== null && value.value !== undefined && operator !== null && isOperator(operator)) {
    compareValue = valueShape(operator, value.value)
    if (compareValue === null) issue(issues, "INVALID_VALUE", "要求的比较值无效。", ref)
  } else if (value.value !== null && value.value !== undefined && operator === null) {
    issue(issues, "INVALID_VALUE", "比较值缺少比较运算符。", ref)
  }
  const asOfRule = text(value.asOfRule)
  if (!(AS_OF_RULES as readonly string[]).includes(asOfRule)) issue(issues, "INVALID_AS_OF", "要求的判定时点规则无效。", ref)
  const materialRelation = text(value.materialRelation)
  if (!materialRelation || materialRelation.length > 200) issue(issues, "INVALID_STRUCTURE", "要求缺少材料关系。", ref)
  const group = inspectGroup(value.group, ref, issues)
  const status = text(value.status)
  if (status !== "confirmed" && status !== "pending") issue(issues, "INVALID_STRUCTURE", "要求状态无效。", ref)
  if (typeof value.statusNote !== "string" || value.statusNote.length > MAX_REASON) issue(issues, "INVALID_STRUCTURE", "要求状态说明无效。", ref)
  const addendum = inspectAddendum(value.addendum, ref, issues)
  if (status === "confirmed") {
    if (nature === REQUIREMENT_NATURE_PENDING) issue(issues, "PENDING_NATURE_CONFIRMED", "性质待确认的要求不能标记为已确认。", ref)
    // A date requirement may omit a fixed comparison date only when its 判定时点
    // is the task asOf (`asOfRule: "task_as_of"`); `not_applicable` never guesses.
    const asOfDateBaseline = isVerificationFieldKey(field) && isOperator(operator) && compareValue === null &&
      asOfRule === "task_as_of" && DATE_OPERATORS.includes(operator)
    if (isVerificationFieldKey(field) && isOperator(operator) && compareValue === null && DATE_OPERATORS.includes(operator) && !asOfDateBaseline) {
      issue(issues, "INVALID_AS_OF", "日期比较缺少固定日期时必须以任务判定日期为判定时点。", ref)
    }
    const hasSingle = isVerificationFieldKey(field) && isOperator(operator) && (compareValue !== null || asOfDateBaseline)
    if (hasSingle && group) issue(issues, "MIXED_EXPRESSION", "要求不能同时使用字段比较与分组条件。", ref)
    if (!hasSingle && !group) issue(issues, "UNEXPRESSED_CONFIRMED", "已确认的要求必须包含可比较的字段或分组条件。", ref)
    if (isVerificationFieldKey(field) && isOperator(operator) && compareValue !== null) {
      const condition: RequirementCondition = { field: field as VerificationFieldKey, operator, value: compareValue }
      if (!validConditionValue(condition)) issue(issues, "INVALID_OPERATOR", "比较运算符与字段类型不匹配。", ref)
    }
  }
  return {
    requirementId,
    subject,
    quote,
    materialVersionId,
    source: { snapshotId, fragmentId },
    addendum,
    nature: ((REQUIREMENT_NATURES as readonly string[]).includes(nature) ? nature : REQUIREMENT_NATURE_PENDING) as VerificationRequirement["nature"],
    field: isVerificationFieldKey(field) ? field : null,
    operator: isOperator(operator) ? operator : null,
    value: compareValue,
    asOfRule: ((AS_OF_RULES as readonly string[]).includes(asOfRule) ? asOfRule : "not_applicable") as VerificationRequirement["asOfRule"],
    materialRelation,
    group,
    status: (status === "confirmed" ? "confirmed" : "pending") as VerificationRequirement["status"],
    statusNote: typeof value.statusNote === "string" ? value.statusNote.trim() : "",
  }
}

function inspectRejected(raw: unknown, issues: Issue[]): Array<{ quote: string; reason: string }> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) { issue(issues, "INVALID_STRUCTURE", "被驳回候选记录无效。"); return [] }
  const rejected: Array<{ quote: string; reason: string }> = []
  for (const [index, item] of raw.entries()) {
    const value = record(item)
    const reason = text(value?.reason)
    const quote = typeof value?.quote === "string" ? value.quote : ""
    if (!value || !reason || reason.length > MAX_REASON || quote.length > 2000) {
      issue(issues, "INVALID_STRUCTURE", "被驳回候选记录无效。", `rejected[${index}]`)
      continue
    }
    rejected.push({ quote, reason })
  }
  return rejected
}

/** Structural inspection shared by the validator and the server-owned save path. */
export function inspectRequirementSet(value: unknown): { value: RequirementSetValue | null; issues: Issue[]; partial: boolean } {
  const issues: Issue[] = []
  const root = record(value)
  if (!root) return { value: null, issues: [{ code: "INVALID_STRUCTURE", message: "要求集不是有效对象。" }], partial: false }
  if (root.schemaVersion !== 1) issue(issues, "INVALID_STRUCTURE", "要求集版本不受支持。")
  if (root.status !== "candidate" && root.status !== "confirmed") issue(issues, "INVALID_STRUCTURE", "要求集状态无效。")
  const rawRequirements = Array.isArray(root.requirements) ? root.requirements : null
  if (!rawRequirements) issue(issues, "INVALID_STRUCTURE", "要求集缺少要求清单。")
  else if (!rawRequirements.length) issue(issues, "INVALID_STRUCTURE", "要求集至少包含一条要求。")
  else if (rawRequirements.length > MAX_REQUIREMENTS) issue(issues, "INVALID_STRUCTURE", `要求数量超过上限（最多 ${MAX_REQUIREMENTS} 条）。`)
  const requirements: VerificationRequirement[] = []
  const seenIds = new Set<string>()
  for (const [index, raw] of (rawRequirements ?? []).entries()) {
    const requirement = inspectRequirement(raw, index, issues, seenIds)
    if (requirement) requirements.push(requirement)
  }
  const rejected = inspectRejected(root.rejected, issues)
  const warnings = Array.isArray(root.warnings) ? root.warnings.filter((item): item is string => typeof item === "string") : []
  if (!Array.isArray(root.warnings) || warnings.length !== (root.warnings as unknown[]).length) issue(issues, "INVALID_STRUCTURE", "要求集提示记录无效。")
  const errors: Array<{ code: string; message: string }> = []
  if (root.errors !== undefined) {
    if (!Array.isArray(root.errors)) issue(issues, "INVALID_STRUCTURE", "要求集错误记录无效。")
    else for (const item of root.errors) {
      const error = record(item)
      if (!error || !text(error.code) || !text(error.message)) { issue(issues, "INVALID_STRUCTURE", "要求集错误记录无效。"); continue }
      errors.push({ code: text(error.code).slice(0, 64), message: text(error.message).slice(0, 500) })
    }
  }
  if (issues.length) return { value: null, issues, partial: false }
  const status = root.status as "candidate" | "confirmed"
  const parsed: RequirementSetValue = { schemaVersion: 1, status, requirements, rejected, warnings, errors }
  const partial = status !== "confirmed" || requirements.some(requirement => requirement.status !== "confirmed")
  return { value: parsed, issues, partial }
}

/** Parse a saved value or throw a controlled code; used by server-owned saves and executors. */
export function parseRequirementSetValue(value: unknown): RequirementSetValue {
  const inspected = inspectRequirementSet(value)
  if (!inspected.value) throw new VerificationError("REQUIREMENT_SET_INVALID")
  return inspected.value
}

/** Server-owned result validator for `bid-requirements`. */
export const bidRequirementSetValidator: ResultValidator = async value => {
  const inspected = inspectRequirementSet(value)
  if (!inspected.value) return { status: "invalid", issues: inspected.issues }
  return { status: inspected.partial ? "partial" : "valid", issues: [] }
}

export type RequirementReadiness =
  | { ok: true }
  | { ok: false; reason: "unconfirmed" | "pending-nature" | "pending-operators" }

/**
 * A comparison may only consume a fully confirmed requirement set. Minimum
 * checks are repeated here even though the validator enforces them, so a
 * mis-wired caller can never compare a candidate set.
 */
export function assertReadyForComparison(value: RequirementSetValue): RequirementReadiness {
  if (value.status !== "confirmed" || value.requirements.some(requirement => requirement.status !== "confirmed")) {
    return { ok: false, reason: "unconfirmed" }
  }
  if (value.requirements.some(requirement => requirement.nature === REQUIREMENT_NATURE_PENDING)) {
    return { ok: false, reason: "pending-nature" }
  }
  const expressible = value.requirements.every(requirement => {
    if (requirement.group !== null) return true
    if (requirement.field === null || requirement.operator === null) return false
    if (requirement.value !== null) return true
    // Date requirements may defer the comparison date to the task asOf.
    return requirement.asOfRule === "task_as_of" && DATE_OPERATORS.includes(requirement.operator)
  })
  if (!expressible) return { ok: false, reason: "pending-operators" }
  return { ok: true }
}

/** Embed exactly the requirement fields a comparison/export may read (no DB, no extra keys). */
export function requirementSetSnapshot(value: RequirementSetValue): RequirementSnapshot[] {
  return value.requirements.map(requirement => ({
    requirementId: requirement.requirementId,
    subject: requirement.subject,
    quote: requirement.quote,
    source: { snapshotId: requirement.source.snapshotId, fragmentId: requirement.source.fragmentId },
    materialVersionId: requirement.materialVersionId,
    nature: requirement.nature,
    field: requirement.field,
    operator: requirement.operator,
    value: requirement.value,
    asOfRule: requirement.asOfRule,
    addendumState: requirement.addendum.state,
    materialRelation: requirement.materialRelation,
    group: requirement.group,
  }))
}

/** Every shared-vocabulary field a requirement set compares (used for the stale-field hint). */
export function requirementFieldKeys(value: RequirementSetValue): Set<VerificationFieldKey> {
  const keys = new Set<VerificationFieldKey>()
  for (const requirement of value.requirements) {
    if (requirement.group) {
      for (const condition of requirement.group.conditions) if (isVerificationFieldKey(condition.field)) keys.add(condition.field)
    } else if (isVerificationFieldKey(requirement.field)) {
      keys.add(requirement.field)
    }
  }
  return keys
}

export type RequirementParagraph = {
  fragmentId: string
  snapshotId: string
  materialVersionId: string
  text: string
}

export type RequirementCandidateMapping = {
  requirements: VerificationRequirement[]
  rejected: Array<{ quote: string; reason: string }>
  warnings: string[]
}

function candidateId(raw: unknown, index: number, seen: Set<string>): string {
  const provided = text(raw)
  if (REQUIREMENT_ID_PATTERN.test(provided) && !seen.has(provided)) { seen.add(provided); return provided }
  let candidate = `req-${index + 1}`
  let suffix = 1
  while (seen.has(candidate)) candidate = `req-${index + 1}-${++suffix}`
  seen.add(candidate)
  return candidate
}

function candidateGroup(raw: unknown): RequirementGroup | null {
  const group = record(raw)
  if (!group || Object.keys(group).some(key => !["operator", "conditions"].includes(key))) return null
  if (group.operator !== "and" && group.operator !== "or") return null
  if (!Array.isArray(group.conditions) || !group.conditions.length || group.conditions.length > MAX_GROUP_CONDITIONS) return null
  const conditions: RequirementCondition[] = []
  for (const item of group.conditions) {
    const condition = record(item)
    if (!condition || Object.keys(condition).some(key => !["field", "operator", "value"].includes(key))) return null
    if (!isVerificationFieldKey(condition.field) || !isOperator(condition.operator)) return null
    const value = valueShape(condition.operator, condition.value)
    if (value === null) return null
    const parsed: RequirementCondition = { field: condition.field, operator: condition.operator, value }
    if (!validConditionValue(parsed)) return null
    conditions.push(parsed)
  }
  return { operator: group.operator, conditions }
}

/**
 * Normalize model requirement candidates against the immutable paragraphs they
 * were read from. A candidate whose quote cannot be located verbatim is rejected
 * (recorded with its reason) instead of being saved as a demo requirement.
 */
export function parseRequirementCandidates(raw: unknown, paragraphs: RequirementParagraph[]): RequirementCandidateMapping {
  const container = Array.isArray(raw) ? { candidates: raw } : record(raw)
  const candidates = Array.isArray(container?.candidates) ? container.candidates as unknown[] : null
  if (!candidates) throw new VerificationError("EXTRACTOR_FAILED")
  if (candidates.length > 100) throw new VerificationError("EXTRACTOR_FAILED")
  const requirements: VerificationRequirement[] = []
  const rejected: Array<{ quote: string; reason: string }> = []
  const warnings: string[] = []
  const seenIds = new Set<string>()
  for (const [index, item] of candidates.entries()) {
    const candidate = record(item)
    const quote = text(candidate?.quote)
    if (!candidate || !quote || quote.length > 2000) {
      rejected.push({ quote: quote.slice(0, 2000), reason: "候选缺少可核对的原文引文" })
      continue
    }
    const matches = paragraphs.filter(paragraph => quotesMatch(paragraph.text, quote))
    if (!matches.length) {
      rejected.push({ quote, reason: "引文未逐字出现在所声明的材料原文中" })
      continue
    }
    const subject = text(candidate.subject)
    if (!subject || subject.length > 200) {
      rejected.push({ quote, reason: "候选缺少义务主体" })
      continue
    }
    const materialRelation = text(candidate.materialRelation)
    if (!materialRelation || materialRelation.length > 200) {
      rejected.push({ quote, reason: "候选缺少材料关系" })
      continue
    }
    const fragment = matches[0]
    if (matches.length > 1) warnings.push("部分候选引文命中多个片段，已按首个片段定位。")
    const nature = (REQUIREMENT_NATURES as readonly string[]).includes(text(candidate.nature))
      ? text(candidate.nature) as VerificationRequirement["nature"]
      : REQUIREMENT_NATURE_PENDING
    const field = isVerificationFieldKey(candidate.field) ? candidate.field : null
    const operator = isOperator(candidate.operator) ? candidate.operator : null
    const compareValue = field && operator && candidate.value !== null && candidate.value !== undefined
      ? valueShape(operator, candidate.value) : null
    const addendumRaw = record(candidate.addendum)
    const addendumState = (ADDENDUM_STATES as readonly unknown[]).includes(addendumRaw?.state)
      ? addendumRaw!.state as VerificationRequirement["addendum"]["state"]
      : (ADDENDUM_STATES as readonly unknown[]).includes(candidate.addendum) ? candidate.addendum : "none"
    const addendumNote = typeof addendumRaw?.note === "string" ? addendumRaw.note.trim().slice(0, MAX_REASON) : ""
    requirements.push({
      requirementId: candidateId(candidate.requirementId, index, seenIds),
      subject,
      quote,
      materialVersionId: fragment.materialVersionId,
      source: { snapshotId: fragment.snapshotId, fragmentId: fragment.fragmentId },
      addendum: { state: addendumState as VerificationRequirement["addendum"]["state"], note: addendumNote },
      nature,
      field,
      operator,
      value: field && operator ? compareValue : null,
      asOfRule: (AS_OF_RULES as readonly string[]).includes(text(candidate.asOfRule))
        ? text(candidate.asOfRule) as VerificationRequirement["asOfRule"] : "not_applicable",
      materialRelation,
      group: candidateGroup(candidate.group),
      status: "pending",
      statusNote: "模型候选，待人工确认。",
    })
  }
  if (rejected.length) warnings.push("部分模型候选因引文无法逐字定位而未被采用。")
  const unconfirmed = requirements.filter(requirement => requirement.nature === REQUIREMENT_NATURE_PENDING || !requirement.field || !requirement.operator)
  if (unconfirmed.length) warnings.push("部分候选的性质或比较表达式待人工确认，不能用于比较。")
  return { requirements, rejected, warnings }
}
