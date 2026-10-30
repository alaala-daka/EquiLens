import {
  ADDENDUM_STATES, AS_OF_RULES, COMPARISON_OPERATORS, DATE_OPERATORS, EXTERNAL_RECORD_CONCLUSIONS,
  LIST_OPERATORS, MATERIAL_CHECK_STATUSES, REQUIREMENT_NATURES, REQUIREMENT_NATURE_PENDING,
  type BidVerificationValue, type ComparisonOperator, type ExternalCheckStatus, type ExternalRecordConclusion,
  type MaterialCheckStatus, type RequirementCondition, type RequirementSetValue,
  type RequirementSnapshot, type VerificationExternalRecordView, type VerificationItem, type VerificationListSummary,
  type VerificationRequirement, type VerificationStaleState,
} from "../../../lib/business/verification-types"
import {
  VERIFICATION_FIELD_KEYS, VERIFICATION_FIELD_LABELS, VERIFICATION_FIELD_TYPES,
  isVerificationFieldKey, normalizeFieldValue, quotesMatch, type VerificationFieldKey,
} from "../../../lib/business/verification-fields"
import type { MaterialSnapshotRead, SnapshotFragment } from "../../../lib/business/materials-client"
import type {
  VerificationFieldView, VerificationMaterial, VerificationTaskView, VerificationTaskKind,
  VerificationResultView,
} from "../../../lib/business/verifications-client"
import type { ResultReview, ResultValidation } from "../../../lib/business/contracts"
import {
  formatElapsedDuration, formatReviewTime,
  reviewActionAvailability, reviewDecisionLabel, validationStatusLabel,
} from "./review-state"

export { reviewActionAvailability, reviewDecisionLabel, validationStatusLabel }

/**
 * Pure logic for the project bid-verification workspace (round-five C4-UI).
 *
 * All requirement/field/record form state machines, client-side preflights,
 * task polling rules and result display projections live here so they can be
 * tested without React or the network. The server remains the sole authority:
 * these checks only prevent obviously invalid saves and explain why a control
 * is disabled; the server-owned save and validators still re-read every source.
 */

export const verificationPollIntervalMs = 5000
export const maxVerificationMaterials = 10
export const maxRequirements = 200
export const maxGroupConditions = 10

/* ------------------------------------------------------------------------- */
/* Labels and vocabulary                                                     */
/* ------------------------------------------------------------------------- */

export const natureLabels: Record<string, string> = {
  [REQUIREMENT_NATURE_PENDING]: "待确认",
  资格否决: "资格否决",
  一般提交: "一般提交",
  可补正: "可补正",
  评分: "评分",
}
export const natureOptions = [...REQUIREMENT_NATURES, REQUIREMENT_NATURE_PENDING] as const

export const operatorLabels: Record<ComparisonOperator, string> = {
  eq: "等于", neq: "不等于", in: "属于", not_in: "不属于", lte: "小于等于", gte: "大于等于",
  on_or_before: "不晚于", on_or_after: "不早于", contains: "包含",
}
export const operatorOptions = COMPARISON_OPERATORS.map(value => ({ value, label: operatorLabels[value] }))

export const asOfRuleOptions = [
  { value: "task_as_of", label: "以任务判定日期为判定时点" },
  { value: "not_applicable", label: "不适用（比较值固定）" },
] as const

export const addendumOptions = [
  { value: "none", label: "无补遗" },
  { value: "conflict", label: "补遗冲突，待人工确认" },
  { value: "revised", label: "已按补遗修订" },
] as const

export const conclusionOptions: ReadonlyArray<{ value: ExternalRecordConclusion; label: string }> = [
  { value: "matched", label: "人工查询记录匹配" },
  { value: "conflict", label: "记录冲突" },
  { value: "not_found", label: "未查到" },
  { value: "query_failed", label: "查询失败" },
  { value: "pending", label: "待人工核验" },
]

export function conclusionLabel(value: string): string {
  return conclusionOptions.find(option => option.value === value)?.label ?? value
}

export const fieldTypeLabels: Record<string, string> = { text: "文本", identifier: "标识", date: "日期", enum: "枚举" }
export const originLabels: Record<string, string> = { ocr: "OCR 识别原值", manual: "人工登记", material_text: "材料原文支持" }
export const supportLabels: Record<string, string> = { ocr: "OCR 原值", material_text: "材料原文支持", pending: "待确认" }
export const materialCheckLabels: Record<MaterialCheckStatus, string> = Object.fromEntries(
  MATERIAL_CHECK_STATUSES.map(status => [status, status]),
) as Record<MaterialCheckStatus, string>

export function fieldLabel(field: string): string {
  return isVerificationFieldKey(field) ? VERIFICATION_FIELD_LABELS[field] : field
}

export function fieldKeyOptions(): Array<{ value: VerificationFieldKey; label: string; type: string }> {
  return VERIFICATION_FIELD_KEYS.map(value => ({ value, label: VERIFICATION_FIELD_LABELS[value], type: fieldTypeLabels[VERIFICATION_FIELD_TYPES[value]] }))
}

/* ------------------------------------------------------------------------- */
/* Materials                                                                 */
/* ------------------------------------------------------------------------- */

/** A document material whose immutable parse snapshot exists and did not fail. */
export function parsedMaterial(material: VerificationMaterial): boolean {
  return material.format !== "image" && Boolean(material.snapshotId) && material.coverage !== null && material.coverage.status !== "failed"
}

/** Materials that may be sent to `bid-requirements` (tender/clarification text). */
export function requirementSourceMaterial(material: VerificationMaterial): boolean {
  return parsedMaterial(material)
}

/** Materials usable as comparison/field evidence: parsed documents or certificate images. */
export function evidenceMaterial(material: VerificationMaterial): boolean {
  return material.format === "image" || parsedMaterial(material)
}

export function materialUnavailableReason(material: VerificationMaterial): string {
  if (material.format === "image") return "证照图片无解析快照，字段需由 OCR 识别或人工登记为待确认"
  if (material.coverage?.status === "failed") return "解析失败"
  if (material.parseState === "queued" || material.parseState === "running") return "正在解析"
  if (!material.snapshotId) return "无解析快照"
  return "不可用"
}

export function materialTitle(materials: readonly VerificationMaterial[], versionId: string): string {
  return materials.find(material => material.versionId === versionId)?.title ?? "不可用的材料版本"
}

export function materialVersionRefs(materials: readonly VerificationMaterial[]): Array<{ materialVersionId: string; sha256: string }> {
  return materials.map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 }))
}

/* ------------------------------------------------------------------------- */
/* Task display and polling                                                  */
/* ------------------------------------------------------------------------- */

export function isVerificationTaskKind(kind: string): kind is VerificationTaskKind {
  return kind === "bid-requirements" || kind === "bid-verification"
}

export function verificationTasksOnly(tasks: readonly VerificationTaskView[]): VerificationTaskView[] {
  return tasks.filter(task => isVerificationTaskKind(task.kind))
}

export function activeTask(task: Pick<VerificationTaskView, "state">): boolean {
  return task.state === "queued" || task.state === "running"
}

export function shouldPollVerificationTasks(tasks: readonly Pick<VerificationTaskView, "state">[]): boolean {
  return tasks.some(task => activeTask(task))
}

const taskStateLabels: Record<string, string> = {
  queued: "排队中", running: "处理中", success: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消",
}
const taskStageLabels: Record<string, string> = {
  submitted: "等待处理", claimed: "正在处理", queued: "等待处理", running: "正在处理",
  success: "处理结束", partial: "部分完成", failed: "处理停止", cancelled: "已取消",
}

export function taskStateLabel(state: string): string {
  return taskStateLabels[state] ?? state
}

export function taskStageLabel(task: Pick<VerificationTaskView, "state" | "stage">): string {
  const label = taskStageLabels[task.stage]
  if (label) return label
  return activeTask(task) ? "正在处理" : taskStateLabel(task.state)
}

export function taskHint(task: Pick<VerificationTaskView, "state">): string {
  switch (task.state) {
    case "queued": return "任务已提交，正在排队。"
    case "running": return "任务正在处理；离开页面不会取消后台任务。"
    case "success": return "任务已完成，机器结果仍需人工确认。"
    case "partial": return "任务部分完成；未完成项仍需人工确认。"
    case "failed": return "任务处理失败，请查看错误并保留已有成果。"
    case "cancelled": return "任务已取消。"
    default: return "任务状态以服务端记录为准。"
  }
}

export function mergeTaskRows(tasks: readonly VerificationTaskView[], updated: VerificationTaskView): VerificationTaskView[] {
  const next = tasks.some(task => task.id === updated.id)
    ? tasks.map(task => task.id === updated.id ? updated : task)
    : [updated, ...tasks]
  return [...next].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

export function finishedTasks(previous: readonly VerificationTaskView[], next: readonly VerificationTaskView[]): VerificationTaskView[] {
  const before = new Map(previous.map(task => [task.id, task.state]))
  return next.filter(task => {
    const earlier = before.get(task.id)
    return (earlier === "queued" || earlier === "running") && !activeTask(task)
  })
}

/** Executors record the saved result reference (resultId/versionId/sha256) in resultSummary. */
export type TaskResultReference = { resultId: string; versionId: string; sha256: string; validation?: string }
export function parseTaskResultReference(summary: string | null): TaskResultReference | null {
  if (!summary) return null
  let value: unknown
  try { value = JSON.parse(summary) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.resultId !== "string" || !record.resultId) return null
  if (typeof record.versionId !== "string" || !record.versionId) return null
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return null
  return {
    resultId: record.resultId,
    versionId: record.versionId,
    sha256: record.sha256,
    ...(typeof record.validation === "string" ? { validation: record.validation } : {}),
  }
}

export function findTaskResultReference(task: Pick<VerificationTaskView, "resultSummary">): TaskResultReference | null {
  return parseTaskResultReference(task.resultSummary)
}

/* ------------------------------------------------------------------------- */
/* Submission signatures and idempotency                                     */
/* ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function manifestRefsSignature(refs: unknown): string {
  const record = asRecord(refs)
  if (!record) return "{}"
  const materials = Array.isArray(record.materials)
    ? record.materials.map(item => {
      const material = asRecord(item)
      return { materialVersionId: typeof material?.materialVersionId === "string" ? material.materialVersionId : "", sha256: typeof material?.sha256 === "string" ? material.sha256 : "" }
    })
    : []
  const requirementSet = asRecord(record.requirementSet)
  const externalRecords = Array.isArray(record.externalRecords)
    ? record.externalRecords.map(item => {
      const entry = asRecord(item)
      return { recordId: typeof entry?.recordId === "string" ? entry.recordId : "", sha256: typeof entry?.sha256 === "string" ? entry.sha256 : "" }
    })
    : []
  return JSON.stringify({ materials, ...(requirementSet ? { requirementSet: { id: String(requirementSet.id ?? ""), versionId: String(requirementSet.versionId ?? ""), sha256: String(requirementSet.sha256 ?? "") } } : {}), ...(record.externalRecords !== undefined ? { externalRecords } : {}) })
}

function manifestConditionsSignature(conditions: unknown): string {
  const record = asRecord(conditions) ?? {}
  return JSON.stringify({
    asOf: typeof record.asOf === "string" ? record.asOf : null,
    externalProcessingConsent: record.externalProcessingConsent === true,
  })
}

export function taskInputSignature(task: Pick<VerificationTaskView, "kind" | "manifest">): string | null {
  if (!isVerificationTaskKind(task.kind)) return null
  return JSON.stringify({
    kind: task.kind,
    refs: manifestRefsSignature(task.manifest.refs),
    conditions: manifestConditionsSignature(task.manifest.conditions),
  })
}

export function submissionInputSignature(kind: VerificationTaskKind, refs: unknown, conditions: unknown): string {
  return JSON.stringify({ kind, refs: manifestRefsSignature(refs), conditions: manifestConditionsSignature(conditions) })
}

export function findEquivalentActiveTask(tasks: readonly VerificationTaskView[], signature: string): VerificationTaskView | null {
  return tasks.find(task => activeTask(task) && taskInputSignature(task) === signature) ?? null
}

export type SubmissionOperation = { signature: string; key: string }
export function nextSubmissionOperation(previous: SubmissionOperation | null, signature: string, createKey: () => string): SubmissionOperation {
  if (previous && previous.signature === signature) return previous
  return { signature, key: createKey() }
}

/* ------------------------------------------------------------------------- */
/* Requirement set decoding and client preflight                            */
/* ------------------------------------------------------------------------- */

function requirementSetCandidate(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value)
  if (!root || root.schemaVersion !== 1) return null
  if (root.status !== "candidate" && root.status !== "confirmed") return null
  if (!Array.isArray(root.requirements) || !root.requirements.length) return null
  return root
}

/** Decode a server-saved requirement set for display/editing; null when the shape is unusable. */
export function requirementSetValue(value: unknown): RequirementSetValue | null {
  const root = requirementSetCandidate(value)
  if (!root) return null
  const requirements = (root.requirements as unknown[]).filter(item => {
    const record = asRecord(item)
    return Boolean(record) && typeof record!.requirementId === "string" && typeof record!.quote === "string" && Boolean(asRecord(record!.source))
  }) as VerificationRequirement[]
  if (!requirements.length) return null
  return {
    schemaVersion: 1,
    status: root.status as RequirementSetValue["status"],
    requirements,
    rejected: Array.isArray(root.rejected) ? root.rejected as RequirementSetValue["rejected"] : [],
    warnings: stringArray(root.warnings),
    errors: Array.isArray(root.errors) ? root.errors as RequirementSetValue["errors"] : [],
  }
}

export function emptyRequirementSet(): RequirementSetValue {
  return { schemaVersion: 1, status: "candidate", requirements: [], rejected: [], warnings: [], errors: [] }
}

export function cloneRequirementSet(value: RequirementSetValue): RequirementSetValue {
  return JSON.parse(JSON.stringify(value)) as RequirementSetValue
}

export function requirementSetCounts(value: RequirementSetValue): {
  total: number
  confirmed: number
  pending: number
  pendingNature: number
  rejected: number
} {
  return {
    total: value.requirements.length,
    confirmed: value.requirements.filter(requirement => requirement.status === "confirmed").length,
    pending: value.requirements.filter(requirement => requirement.status !== "confirmed").length,
    pendingNature: value.requirements.filter(requirement => requirement.nature === REQUIREMENT_NATURE_PENDING).length,
    rejected: value.rejected.length,
  }
}

export function requirementSetStatusLabel(value: RequirementSetValue): string {
  return value.status === "confirmed" ? "已确认要求集" : "要求候选（待确认）"
}

/** Mirrors `assertReadyForComparison` on the server: confirmed set + no pending nature + expressible. */
export function comparisonReadiness(value: RequirementSetValue): { ready: boolean; reason: string } {
  if (value.status !== "confirmed" || value.requirements.some(requirement => requirement.status !== "confirmed")) {
    return { ready: false, reason: "要求集尚未全部确认，不能用于比较。" }
  }
  if (value.requirements.some(requirement => requirement.nature === REQUIREMENT_NATURE_PENDING)) {
    return { ready: false, reason: "存在性质待确认的要求，不能用于比较。" }
  }
  const expressible = value.requirements.every(requirement => {
    if (requirement.group) return true
    if (!requirement.field || !requirement.operator) return false
    if (requirement.value !== null) return true
    return requirement.asOfRule === "task_as_of" && DATE_OPERATORS.includes(requirement.operator)
  })
  if (!expressible) return { ready: false, reason: "存在不能确定性执行的要求，请补充字段或分组条件。" }
  return { ready: true, reason: "" }
}

/** Root status follows the per-requirement confirmation state; saving never upgrades by accident. */
export function preparedRequirementSet(value: RequirementSetValue): RequirementSetValue {
  const readiness = comparisonReadiness(value)
  return { ...value, status: readiness.ready ? "confirmed" : "candidate" }
}

function isOperatorValue(value: unknown): value is ComparisonOperator {
  return typeof value === "string" && (COMPARISON_OPERATORS as readonly string[]).includes(value)
}

function checkConditionValue(condition: RequirementCondition, label: string, issues: string[]): void {
  if (LIST_OPERATORS.includes(condition.operator)) {
    if (!Array.isArray(condition.value) || !condition.value.length || condition.value.some(item => !item.trim())) {
      issues.push(`${label}的比较值须为至少一项列表。`)
      return
    }
  } else if (typeof condition.value !== "string" || !condition.value.trim()) {
    issues.push(`${label}的比较值不能为空。`)
    return
  }
  if (DATE_OPERATORS.includes(condition.operator) && VERIFICATION_FIELD_TYPES[condition.field] !== "date") {
    issues.push(`${label}的日期运算符只能用于日期字段。`)
  }
}

const requirementIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Client preflight for one requirement; the server-owned save remains authoritative. */
export function checkRequirementItem(requirement: VerificationRequirement, index: number): { issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  const label = `第 ${index + 1} 条要求`
  if (!requirementIdPattern.test(requirement.requirementId)) issues.push(`${label}编号无效。`)
  if (!requirement.subject.trim() || requirement.subject.length > 200) issues.push(`${label}缺少有效的义务主体。`)
  if (!requirement.quote.trim() || requirement.quote.length > 2000) issues.push(`${label}缺少原文引文。`)
  if (!requirement.source.snapshotId || !requirement.source.fragmentId) issues.push(`${label}缺少解析快照或原文片段。`)
  if (!requirement.materialRelation.trim() || requirement.materialRelation.length > 200) issues.push(`${label}缺少材料关系。`)
  if (!(natureOptions as readonly string[]).includes(requirement.nature)) issues.push(`${label}性质无效。`)
  if (!(AS_OF_RULES as readonly string[]).includes(requirement.asOfRule)) issues.push(`${label}判定时点规则无效。`)
  if (!(ADDENDUM_STATES as readonly string[]).includes(requirement.addendum.state)) issues.push(`${label}补遗状态无效。`)
  if (requirement.addendum.note.length > 500) issues.push(`${label}补遗说明过长。`)
  if (requirement.statusNote.length > 500) issues.push(`${label}状态说明过长。`)
  if (requirement.field !== null && !isVerificationFieldKey(requirement.field)) issues.push(`${label}字段不在证照字段词表内。`)
  if (requirement.operator !== null && !isOperatorValue(requirement.operator)) issues.push(`${label}比较运算符无效。`)
  // A candidate may keep a pending status but its declared comparison value still has to be structurally valid.
  if (requirement.status !== "confirmed" && requirement.value !== null && requirement.value !== undefined) {
    if (requirement.operator === null) issues.push(`${label}比较值缺少比较运算符。`)
    else if (requirement.field !== null && isVerificationFieldKey(requirement.field)) {
      checkConditionValue({ field: requirement.field, operator: requirement.operator, value: requirement.value }, label, issues)
    }
  }
  const group = requirement.group
  if (group) {
    if (Object.keys(group).some(key => key !== "operator" && key !== "conditions")) issues.push(`${label}不支持嵌套分组。`)
    if (group.operator !== "and" && group.operator !== "or") issues.push(`${label}分组逻辑运算无效。`)
    if (!Array.isArray(group.conditions) || group.conditions.length < 1 || group.conditions.length > maxGroupConditions) issues.push(`${label}分组条件数量无效。`)
    group.conditions?.forEach((condition, position) => {
      if (!isVerificationFieldKey(condition.field)) issues.push(`${label}第 ${position + 1} 个条件字段无效。`)
      if (!isOperatorValue(condition.operator)) issues.push(`${label}第 ${position + 1} 个条件运算符无效。`)
      if (isVerificationFieldKey(condition.field) && isOperatorValue(condition.operator)) {
        checkConditionValue({ field: condition.field, operator: condition.operator, value: condition.value }, `${label}第 ${position + 1} 个条件`, issues)
      }
    })
  }
  if (requirement.status === "confirmed") {
    if (requirement.nature === REQUIREMENT_NATURE_PENDING) issues.push(`${label}性质待确认，不能标记为已确认。`)
    const single = requirement.field !== null && requirement.operator !== null && requirement.value !== null && isOperatorValue(requirement.operator)
    const asOfDate = requirement.field !== null && requirement.operator !== null && isOperatorValue(requirement.operator) &&
      requirement.value === null && requirement.asOfRule === "task_as_of" && DATE_OPERATORS.includes(requirement.operator)
    if (single && group) issues.push(`${label}不能同时使用字段比较与分组条件。`)
    if (!single && !asOfDate && !group) issues.push(`${label}已确认但缺少可执行的字段或分组条件。`)
    if (single && isVerificationFieldKey(requirement.field) && isOperatorValue(requirement.operator)) {
      checkConditionValue({ field: requirement.field, operator: requirement.operator, value: requirement.value as string | string[] }, label, issues)
    }
    if (requirement.value !== null && requirement.operator === null) issues.push(`${label}比较值缺少比较运算符。`)
  }
  if (requirement.addendum.state === "conflict") warnings.push(`${label}存在补遗冲突，比较时该要求会标记为待确认。`)
  return { issues, warnings }
}

/** Whole-set client preflight mirroring the server's structural checks (no verbatim DB read). */
export function checkRequirementSet(value: RequirementSetValue): { issues: string[]; warnings: string[]; status: "confirmed" } {
  const issues: string[] = []
  const warnings: string[] = []
  if (value.schemaVersion !== 1) issues.push("要求集版本不受支持。")
  if (!value.requirements.length) issues.push("要求集至少需要一条要求。")
  if (value.requirements.length > maxRequirements) issues.push(`要求数量超过上限（最多 ${maxRequirements} 条）。`)
  const seen = new Set<string>()
  value.requirements.forEach((requirement, index) => {
    if (seen.has(requirement.requirementId)) issues.push(`第 ${index + 1} 条要求的编号重复。`)
    seen.add(requirement.requirementId)
    const checked = checkRequirementItem(requirement, index)
    issues.push(...checked.issues)
    warnings.push(...checked.warnings)
  })
  value.rejected.forEach((entry, index) => {
    if (!entry.reason.trim() || entry.reason.length > 500) issues.push(`第 ${index + 1} 条驳回记录缺少理由。`)
    if (entry.quote.length > 2000) issues.push(`第 ${index + 1} 条驳回记录引文过长。`)
  })
  value.errors.forEach((entry, index) => {
    if (!entry.code.trim() || !entry.message.trim() || entry.code.length > 64 || entry.message.length > 500) issues.push(`第 ${index + 1} 条错误记录无效。`)
  })
  return { issues, warnings, status: "confirmed" }
}

export function requirementExpressionLabel(requirement: VerificationRequirement): string {
  if (requirement.group) {
    const parts = requirement.group.conditions.map(condition =>
      `${fieldLabel(condition.field)} ${operatorLabels[condition.operator] ?? condition.operator} ${Array.isArray(condition.value) ? condition.value.join("、") : condition.value}`)
    return parts.join(requirement.group.operator === "and" ? " 且 " : " 或 ")
  }
  if (requirement.field && requirement.operator) {
    const value = requirement.value === null
      ? requirement.asOfRule === "task_as_of" ? "任务判定日期" : "未填写"
      : Array.isArray(requirement.value) ? requirement.value.join("、") : requirement.value
    return `${fieldLabel(requirement.field)} ${operatorLabels[requirement.operator] ?? requirement.operator} ${value}`
  }
  return "未设置比较条件"
}

export function requirementSourceLabel(requirement: VerificationRequirement, materials: readonly VerificationMaterial[]): string {
  const title = materialTitle(materials, requirement.materialVersionId)
  return `${title} · 快照 ${requirement.source.snapshotId.slice(0, 8)} · 片段 ${requirement.source.fragmentId.slice(0, 8)}`
}

export function newRequirementId(existing: RequirementSetValue): string {
  const used = new Set(existing.requirements.map(requirement => requirement.requirementId))
  for (let index = existing.requirements.length + 1; index < existing.requirements.length + 500; index++) {
    const candidate = `REQ-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `REQ-${Date.now().toString(36)}`
}

/** A manual requirement starts pending; the human must choose nature and expression before confirming. */
export function newManualRequirement(fragment: SnapshotFragment, material: VerificationMaterial, existing: RequirementSetValue): VerificationRequirement {
  return {
    requirementId: newRequirementId(existing),
    subject: "",
    quote: fragment.text.trim(),
    materialVersionId: material.versionId,
    source: { snapshotId: material.snapshotId ?? "", fragmentId: fragment.id },
    addendum: { state: "none", note: "" },
    nature: REQUIREMENT_NATURE_PENDING,
    field: null,
    operator: null,
    value: null,
    asOfRule: "not_applicable",
    materialRelation: "未指定",
    group: null,
    status: "pending",
    statusNote: "人工录入，待确认性质与比较条件。",
  }
}

export function updateRequirement(value: RequirementSetValue, requirementId: string, patch: Partial<VerificationRequirement>): RequirementSetValue {
  return { ...value, requirements: value.requirements.map(requirement => requirement.requirementId === requirementId ? { ...requirement, ...patch } : requirement) }
}

export function confirmRequirement(value: RequirementSetValue, requirementId: string): RequirementSetValue {
  return updateRequirement(value, requirementId, { status: "confirmed", statusNote: "" })
}

export function markRequirementPending(value: RequirementSetValue, requirementId: string, note = ""): RequirementSetValue {
  return updateRequirement(value, requirementId, { status: "pending", statusNote: note || "待人工确认。" })
}

/** Removing a requirement never deletes its evidence: it becomes an auditable rejected candidate. */
export function rejectRequirement(value: RequirementSetValue, requirementId: string, reason: string): RequirementSetValue {
  const requirement = value.requirements.find(item => item.requirementId === requirementId)
  if (!requirement) return value
  return {
    ...value,
    requirements: value.requirements.filter(item => item.requirementId !== requirementId),
    rejected: [...value.rejected, { quote: requirement.quote, reason: reason.trim() || "人工驳回该候选要求。" }],
  }
}

export function restoreRejected(value: RequirementSetValue, index: number): VerificationRequirement | null {
  const entry = value.rejected[index]
  if (!entry) return null
  return {
    requirementId: newRequirementId(value),
    subject: "",
    quote: entry.quote,
    materialVersionId: "",
    source: { snapshotId: "", fragmentId: "" },
    addendum: { state: "none", note: "" },
    nature: REQUIREMENT_NATURE_PENDING,
    field: null,
    operator: null,
    value: null,
    asOfRule: "not_applicable",
    materialRelation: "未指定",
    group: null,
    status: "pending",
    statusNote: "从驳回记录恢复，需重新选择来源。",
  }
}

export function updateRejectedReason(value: RequirementSetValue, index: number, reason: string): RequirementSetValue {
  return { ...value, rejected: value.rejected.map((entry, position) => position === index ? { ...entry, reason } : entry) }
}

export function removeRejected(value: RequirementSetValue, index: number): RequirementSetValue {
  return { ...value, rejected: value.rejected.filter((_, position) => position !== index) }
}

/* ------------------------------------------------------------------------- */
/* Fragment picker                                                           */
/* ------------------------------------------------------------------------- */

export function filterFragments(fragments: readonly SnapshotFragment[], query: string): SnapshotFragment[] {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return [...fragments]
  return fragments.filter(fragment => fragment.text.toLocaleLowerCase().includes(keyword))
}

export function fragmentLocationLabel(fragment: SnapshotFragment): string {
  const parts: string[] = []
  if (fragment.headingPath.length) parts.push(fragment.headingPath.join(" › "))
  if (fragment.kind === "table") {
    parts.push(`表 ${(fragment.tableIndex ?? 0) + 1}`)
    if (fragment.row !== null && fragment.column !== null) parts.push(`第 ${fragment.row + 1} 行第 ${fragment.column + 1} 列`)
  } else if (fragment.paragraph !== null) parts.push(`第 ${fragment.paragraph + 1} 段`)
  if (fragment.page !== null) parts.push(`第 ${fragment.page + 1} 页`)
  return parts.join(" · ") || `片段 ${fragment.order + 1}`
}

export function fragmentPreview(fragment: SnapshotFragment, limit = 120): string {
  const characters = Array.from(fragment.text.replace(/\s+/g, " ").trim())
  return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("") + "…"
}

/** Quote must be a whitespace-normalized substring of the selected fragment (server re-checks). */
export function quoteMatchesFragment(fragmentText: string, quote: string): boolean {
  return quotesMatch(fragmentText, quote)
}

export function snapshotReadable(read: MaterialSnapshotRead | null): boolean {
  return Boolean(read && Array.isArray(read.fragments) && read.fragments.length)
}

/* ------------------------------------------------------------------------- */
/* Material field form                                                       */
/* ------------------------------------------------------------------------- */

export type FieldForm = {
  fieldKey: VerificationFieldKey
  valueText: string
  subjectKey: string
  sourceFragmentId: string
  reason: string
}

export function defaultFieldForm(): FieldForm {
  return { fieldKey: "subject_name", valueText: "", subjectKey: "enterprise", sourceFragmentId: "", reason: "" }
}

export function fieldFormFromView(view: VerificationFieldView): FieldForm {
  return {
    fieldKey: view.fieldKey,
    valueText: view.valueText,
    subjectKey: view.subjectKey,
    sourceFragmentId: view.sourceFragmentId ?? "",
    reason: "",
  }
}

const subjectKeyPattern = /^[A-Za-z0-9_.:-]{1,64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateFieldForm(form: FieldForm, context: {
  fields: readonly VerificationFieldView[]
  fragmentText: string | null
}): { ready: boolean; issues: string[]; write: { fieldKey: VerificationFieldKey; valueText: string; subjectKey: string; sourceFragmentId?: string } | null; reason: string | null } {
  const issues: string[] = []
  const valueText = form.valueText.trim()
  if (!isVerificationFieldKey(form.fieldKey)) issues.push("字段不在证照字段词表内。")
  if (!valueText) issues.push("字段值不能为空。")
  if (valueText.length > 2000) issues.push("字段值过长。")
  if (!subjectKeyPattern.test(form.subjectKey)) issues.push("主体标识无效（1—64 位字母、数字或 . _ : -）。")
  if (valueText && isVerificationFieldKey(form.fieldKey)) {
    const type = VERIFICATION_FIELD_TYPES[form.fieldKey]
    const normalized = normalizeFieldValue(form.fieldKey, valueText)
    if ((type === "date" || type === "identifier") && !normalized) issues.push(type === "date" ? "日期需填写可识别的日期。" : "标识字段值无效。")
  }
  const sourceFragmentId = form.sourceFragmentId.trim()
  if (sourceFragmentId) {
    if (!uuidPattern.test(sourceFragmentId)) issues.push("来源片段标识无效。")
    else if (context.fragmentText === null) issues.push("请先读取来源快照片段。")
    else if (!quotesMatch(context.fragmentText, valueText)) issues.push("字段值未能在所选材料原文中逐字核对，不能计为材料支持。")
  }
  const existing = context.fields.find(field => field.fieldKey === form.fieldKey && field.subjectKey === form.subjectKey)
  const reason = form.reason.trim()
  if (existing && !reason) issues.push("更正已有字段需要填写更正理由。")
  if (reason.length > 500) issues.push("更正理由过长。")
  return {
    ready: issues.length === 0,
    issues,
    write: issues.length ? null : {
      fieldKey: form.fieldKey,
      valueText,
      subjectKey: form.subjectKey,
      ...(sourceFragmentId ? { sourceFragmentId } : {}),
    },
    reason: reason || null,
  }
}

export function fieldDisplayValue(view: VerificationFieldView): string {
  return view.valueText
}

export function fieldSourceLabel(view: VerificationFieldView): string {
  const base = originLabels[view.origin] ?? view.origin
  return view.confidence === null ? base : `${base} · 置信度 ${view.confidence}`
}

/* ------------------------------------------------------------------------- */
/* External verification record form                                        */
/* ------------------------------------------------------------------------- */

export type ExternalRecordForm = {
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: ExternalRecordConclusion | ""
  proofMaterialVersionId: string
}

export function defaultExternalRecordForm(): ExternalRecordForm {
  return { requirementId: "", subject: "", certificateNo: "", source: "", queriedAt: "", queryConditions: "", conclusion: "", proofMaterialVersionId: "" }
}

export function recordFormFromRequirement(requirement: RequirementSnapshot, evidence: VerificationItem["evidence"]): ExternalRecordForm {
  const certificate = evidence.find(item => item.fieldKey === "certificate_number")
    ?? evidence.find(item => item.fieldKey === "unified_social_credit_code")
  return {
    requirementId: requirement.requirementId,
    subject: requirement.subject,
    certificateNo: certificate?.valueText ?? "",
    source: "",
    queriedAt: "",
    queryConditions: "",
    conclusion: "",
    proofMaterialVersionId: "",
  }
}

export function normalizeQueriedAt(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return null
  const iso = new Date(parsed).toISOString()
  return iso.length <= 32 ? iso : null
}

export function validateExternalRecordForm(form: ExternalRecordForm, context: {
  requirementIds: ReadonlySet<string>
  proofVersionIds: ReadonlySet<string>
}): { ready: boolean; issues: string[]; value: {
  requirementId: string; subject: string; certificateNo: string; source: string; queriedAt: string
  queryConditions: string; conclusion: ExternalRecordConclusion; proofMaterialVersionId: string
} | null } {
  const issues: string[] = []
  const requirementId = form.requirementId.trim()
  if (!requirementId || !context.requirementIds.has(requirementId)) issues.push("请选择该核验成果中的要求。")
  const subject = form.subject.trim()
  if (!subject || subject.length > 200) issues.push("查询主体不能为空且不超过 200 字。")
  const certificateNo = form.certificateNo.trim()
  if (!certificateNo || certificateNo.length > 128) issues.push("证号不能为空且不超过 128 字。")
  const source = form.source.trim()
  if (!source || source.length > 500) issues.push("查询来源不能为空且不超过 500 字。")
  const queriedAt = normalizeQueriedAt(form.queriedAt)
  if (!queriedAt) issues.push("请填写有效的查询时间。")
  const queryConditions = form.queryConditions.trim()
  if (!queryConditions || queryConditions.length > 500) issues.push("查询条件不能为空且不超过 500 字。")
  if (!(EXTERNAL_RECORD_CONCLUSIONS as readonly string[]).includes(form.conclusion)) issues.push("请选择查询结论。")
  const proofMaterialVersionId = form.proofMaterialVersionId.trim()
  if (!proofMaterialVersionId || !context.proofVersionIds.has(proofMaterialVersionId)) issues.push("请选择本项目内的证明材料版本。")
  const ready = issues.length === 0
  return {
    ready,
    issues,
    value: ready ? {
      requirementId, subject, certificateNo, source, queriedAt: queriedAt as string, queryConditions,
      conclusion: form.conclusion as ExternalRecordConclusion, proofMaterialVersionId,
    } : null,
  }
}

export function externalRecordRequirementOptions(value: BidVerificationValue | null): RequirementSnapshot[] {
  return value?.requirementSet.requirements ?? []
}

/* ------------------------------------------------------------------------- */
/* Comparison result projections                                            */
/* ------------------------------------------------------------------------- */

export function bidVerificationValue(value: unknown): BidVerificationValue | null {
  const root = asRecord(value)
  if (!root || root.schemaVersion !== 1) return null
  if (root.status !== "success" && root.status !== "partial") return null
  if (!Array.isArray(root.items) || !Array.isArray(root.unfinished)) return null
  const requirementSet = asRecord(root.requirementSet)
  if (!requirementSet || !Array.isArray(requirementSet.requirements)) return null
  if (!root.coverage || typeof root.coverage !== "object") return null
  return root as unknown as BidVerificationValue
}

export function requirementSnapshotById(value: BidVerificationValue): Map<string, RequirementSnapshot> {
  return new Map(value.requirementSet.requirements.map(requirement => [requirement.requirementId, requirement]))
}

export type VerificationItemRow = {
  item: VerificationItem
  requirement: RequirementSnapshot | null
  subject: string
  quote: string
  materialCheck: string
  externalCheck: string
  evidenceLabel: string
}

export function verificationItemRows(value: BidVerificationValue): VerificationItemRow[] {
  const byId = requirementSnapshotById(value)
  return value.items.map(item => {
    const requirement = byId.get(item.requirementId) ?? null
    return {
      item,
      requirement,
      subject: requirement?.subject ?? "未标注",
      quote: requirement?.quote ?? "",
      materialCheck: item.materialCheck,
      externalCheck: item.externalCheck,
      evidenceLabel: item.evidence.length
        ? item.evidence.map(entry => `${fieldLabel(entry.fieldKey)}=${entry.valueText}（${originLabels[entry.origin] ?? entry.origin}${entry.confidence === null ? "" : `，置信度 ${entry.confidence}`}，${entry.subjectKey}）`).join("；")
        : "无可用于比较的材料字段",
    }
  })
}

export function materialCheckTone(status: MaterialCheckStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "满足材料要求") return "default"
  if (status === "材料缺失" || status === "字段冲突" || status === "日期不满足") return "destructive"
  return "secondary"
}

export function externalCheckTone(status: ExternalCheckStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "人工查询记录匹配") return "default"
  if (status === "记录冲突") return "destructive"
  return "outline"
}

/** Only a matched manual record is a pass; every other external status stays unresolved. */
export function externalStatusIsPass(status: string): boolean {
  return status === "人工查询记录匹配"
}

export function coverageSummaryLabel(value: BidVerificationValue): string {
  const coverage = value.coverage
  return `要求 ${coverage.requirements} 项 · 已比较 ${coverage.compared} 项 · 材料满足 ${coverage.materialSatisfied} 项 · 缺失 ${coverage.materialMissing} 项 · 冲突 ${coverage.fieldConflict} 项 · 日期不满足 ${coverage.dateUnsatisfied} 项 · 待确认 ${coverage.pending} 项 · 外部匹配 ${coverage.externalMatched} 项 · 外部未核验 ${coverage.externalUnverified} 项`
}

export function staleHint(stale: VerificationStaleState | null): string {
  if (!stale) return ""
  return stale.hint ?? ""
}

export function resultKindLabel(kind: string): string {
  return kind === "bid-requirements" ? "要求集" : kind === "bid-verification" ? "核验结果" : kind
}

export function requirementSetSummary(value: RequirementSetValue): string {
  const counts = requirementSetCounts(value)
  return `${requirementSetStatusLabel(value)} · 共 ${counts.total} 条 · 已确认 ${counts.confirmed} 条 · 待确认 ${counts.pending} 条 · 性质待确认 ${counts.pendingNature} 条 · 驳回 ${counts.rejected} 条`
}

export function verificationListItems(items: readonly VerificationListSummary[], kind: "bid-requirements" | "bid-verification"): VerificationListSummary[] {
  return items.filter(item => item.kind === kind).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.resultId.localeCompare(left.resultId))
}

/** Only a confirmed, validator-valid requirement set may be used for comparison. */
export function comparisonRequirementSetOptions(items: readonly VerificationListSummary[]): VerificationListSummary[] {
  return verificationListItems(items, "bid-requirements").filter(item =>
    item.summary.status === "confirmed" && item.validation.status === "valid")
}

export function resultReviewLabels(result: Pick<VerificationResultView, "validation" | "review">): { validation: string; review: string } {
  return { validation: validationStatusLabel(result.validation.status), review: reviewDecisionLabel(result.review) }
}

export function couldApprove(canEdit: boolean, result: Pick<VerificationResultView, "validation" | "review">) {
  return reviewActionAvailability(canEdit, result.validation, result.review)
}

/**
 * `bid-requirements` has no production export template; a comparison may be
 * exported as a draft unless its validation is invalid (spec 01 §8.2.3).
 */
export function couldExport(canEdit: boolean, kind: string, validation: Pick<ResultValidation, "status">): { canExport: boolean; hint: string } {
  if (!canEdit) return { canExport: false, hint: "只读成员不能创建导出。" }
  if (kind !== "bid-verification") return { canExport: false, hint: "要求集不提供 Word 导出。" }
  if (validation.status === "invalid") return { canExport: false, hint: "成果校验未通过，不能导出。" }
  return { canExport: true, hint: "" }
}

export function verificationExportBaseName(): string {
  return "投标材料核验报告"
}

export function reviewDecisionFromForm(decision: ResultReview["decision"]): string {
  return reviewDecisionLabel(decision === "approved" ? { versionId: "", decision, comment: "", reviewedBy: "", reviewedAt: "" } : { versionId: "", decision, comment: "", reviewedBy: "", reviewedAt: "" })
}

/* ------------------------------------------------------------------------- */
/* Extraction and comparison submissions                                    */
/* ------------------------------------------------------------------------- */

export type ExtractionForm = { materialIds: string[]; asOf: string; consent: boolean }
export function defaultExtractionForm(): ExtractionForm {
  return { materialIds: [], asOf: "", consent: false }
}

export type RequirementTaskSubmission = {
  kind: "bid-requirements"
  refs: { materials: Array<{ materialVersionId: string; sha256: string }> }
  conditions: { asOf?: string; externalProcessingConsent: true }
}

export function buildRequirementsSubmission(form: ExtractionForm, materials: readonly VerificationMaterial[]): {
  ready: boolean
  issues: string[]
  submission: RequirementTaskSubmission | null
} {
  const issues: string[] = []
  const selected = form.materialIds.flatMap(id => {
    const material = materials.find(item => item.id === id)
    return material && requirementSourceMaterial(material) ? [material] : []
  })
  if (selected.length < 1) issues.push("请选择至少 1 份已解析的招标、澄清或补遗材料。")
  if (selected.length > maxVerificationMaterials) issues.push(`一次最多选择 ${maxVerificationMaterials} 份材料。`)
  if (form.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(form.asOf)) issues.push("判定日期格式无效。")
  if (!form.consent) issues.push("请确认将所选材料发送给第三方模型服务。")
  const ready = issues.length === 0
  return {
    ready,
    issues,
    submission: ready ? {
      kind: "bid-requirements",
      refs: { materials: materialVersionRefs(selected) },
      conditions: { externalProcessingConsent: true, ...(form.asOf ? { asOf: form.asOf } : {}) },
    } : null,
  }
}

export type ComparisonForm = {
  materialIds: string[]
  requirementSetResultId: string
  asOf: string
  recordIds: string[]
}
export function defaultComparisonForm(): ComparisonForm {
  return { materialIds: [], requirementSetResultId: "", asOf: "", recordIds: [] }
}

export type VerificationTaskSubmission = {
  kind: "bid-verification"
  refs: {
    materials: Array<{ materialVersionId: string; sha256: string }>
    requirementSet: { id: string; versionId: string; sha256: string }
    externalRecords: Array<{ recordId: string; sha256: string }>
  }
  conditions: { asOf: string }
}

export function buildComparisonSubmission(form: ComparisonForm, materials: readonly VerificationMaterial[], requirementSet: { id: string; versionId: string; sha256: string } | null, records: readonly VerificationExternalRecordView[]): {
  ready: boolean
  issues: string[]
  submission: VerificationTaskSubmission | null
} {
  const issues: string[] = []
  const selected = form.materialIds.flatMap(id => {
    const material = materials.find(item => item.id === id)
    return material && evidenceMaterial(material) ? [material] : []
  })
  if (selected.length < 1) issues.push("请选择至少 1 份参与比较的材料版本。")
  if (selected.length > maxVerificationMaterials) issues.push(`一次最多选择 ${maxVerificationMaterials} 份材料。`)
  if (!requirementSet) issues.push("请选择已确认的要求集版本。")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.asOf)) issues.push("请填写明确的判定日期。")
  const chosenRecords = records.filter(record => form.recordIds.includes(record.recordId))
  const ready = issues.length === 0 && requirementSet !== null
  return {
    ready,
    issues,
    submission: ready && requirementSet ? {
      kind: "bid-verification",
      refs: {
        materials: materialVersionRefs(selected),
        requirementSet: { id: requirementSet.id, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
        externalRecords: chosenRecords.map(record => ({ recordId: record.recordId, sha256: record.sha256 })),
      },
      conditions: { asOf: form.asOf },
    } : null,
  }
}

/** Deterministic ordering/text used by the task and result panels. */
export function formatTaskTime(iso: string): string {
  return formatReviewTime(iso)
}

export function formatTaskElapsed(task: Pick<VerificationTaskView, "elapsedMs">): string {
  return formatElapsedDuration(task.elapsedMs) || "0 秒"
}
