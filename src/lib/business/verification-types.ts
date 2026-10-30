import type { VerificationFieldKey } from "./verification-fields"

/**
 * C4 bid-verification domain contracts (round-four W0/C4-VERIFY).
 *
 * Client-safe value shapes only: no database rows, no server-only imports and no
 * timestamps generated here. The server validators (`bidRequirementSetValidator`
 * and `bidVerificationResultValidator`) are the authority for which values may
 * be saved; this module is the single vocabulary both the server and the next
 * round's UI share, so the two status dimensions cannot drift.
 *
 * Design decisions frozen by spec 01 §4.3/§8.2.3/§9.3:
 * - 要求集 (requirement set) is an immutable result value confirmed by a human
 *   through the server-owned save path; machine candidates stay `candidate`.
 * - 材料检查 (material check) and 外部真实性 (external check) are independent.
 *   A material pass never implies an external pass and vice versa.
 * - `人工查询记录匹配` is the only external status that records a manual match;
 *   未核验/未查到/查询失败/待人工核验 never become a pass.
 * - No float amounts and no free-form model output: every compared requirement
 *   carries a field from the shared vocabulary plus a known operator.
 */

export const REQUIREMENT_NATURES = ["资格否决", "一般提交", "可补正", "评分"] as const
export type RequirementNature = (typeof REQUIREMENT_NATURES)[number]
/** A model/human has not decided the nature yet; it can never act as a veto. */
export const REQUIREMENT_NATURE_PENDING = "待确认" as const
export type RequirementNatureValue = RequirementNature | typeof REQUIREMENT_NATURE_PENDING

export const COMPARISON_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "lte",
  "gte",
  "on_or_before",
  "on_or_after",
  "contains",
] as const
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]

/** Date operators; the field must be of the shared `date` type. */
export const DATE_OPERATORS: readonly ComparisonOperator[] = ["lte", "gte", "on_or_before", "on_or_after"]
/** Operators whose expected value is a list. */
export const LIST_OPERATORS: readonly ComparisonOperator[] = ["in", "not_in"]

export const REQUIREMENT_STATUSES = ["confirmed", "pending"] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

export const ADDENDUM_STATES = ["none", "conflict", "revised"] as const
export type AddendumState = (typeof ADDENDUM_STATES)[number]

/** How a requirement's 判定时点 is resolved. Comparison tasks always carry an explicit `asOf`. */
export const AS_OF_RULES = ["task_as_of", "not_applicable"] as const
export type RequirementAsOfRule = (typeof AS_OF_RULES)[number]

export type RequirementSource = {
  /** Project parse snapshot that contains the tender text. */
  snapshotId: string
  /** Project source fragment inside that snapshot. */
  fragmentId: string
}

/** One field condition inside a single-level AND/OR group. */
export type RequirementCondition = {
  field: VerificationFieldKey
  operator: ComparisonOperator
  /** Scalar text for scalar operators; list of texts for in/not_in. */
  value: string | string[]
}

/** Demo supports exactly one level of AND/OR; nested groups are a human task. */
export type RequirementGroup = {
  operator: "and" | "or"
  conditions: RequirementCondition[]
}

/**
 * One confirmed-or-pending bid requirement. `field/operator/value` and `group`
 * are mutually exclusive; a `confirmed` requirement carries exactly one of them.
 */
export type VerificationRequirement = {
  requirementId: string
  /** 义务主体 as written in the tender text (no invented legal roles). */
  subject: string
  /** 原文; must appear verbatim (whitespace-normalized) in `source`. */
  quote: string
  /** Tender/clarification/addendum material version the quote belongs to. */
  materialVersionId: string
  source: RequirementSource
  /** 补遗版本与冲突状态; `conflict` can never be auto-resolved. */
  addendum: { state: AddendumState; note: string }
  nature: RequirementNatureValue
  field: VerificationFieldKey | null
  operator: ComparisonOperator | null
  value: string | string[] | null
  asOfRule: RequirementAsOfRule
  /** 材料关系 description, e.g. 企业资质证书 / 人员证书 / 未指定. */
  materialRelation: string
  group: RequirementGroup | null
  status: RequirementStatus
  /** Human note for why a requirement is still pending (固定文案，不含模型原文). */
  statusNote: string
}

/** Immutable `bid-requirements` result value. */
export type RequirementSetValue = {
  schemaVersion: 1
  /** candidate = machine proposal / partially confirmed; confirmed = ready for comparison. */
  status: "candidate" | "confirmed"
  requirements: VerificationRequirement[]
  /** Model candidates a human rejected, kept for audit; never compared. */
  rejected: Array<{ quote: string; reason: string }>
  warnings: string[]
  errors: Array<{ code: string; message: string }>
}

export const MATERIAL_CHECK_STATUSES = ["满足材料要求", "材料缺失", "字段冲突", "日期不满足", "待确认"] as const
export type MaterialCheckStatus = (typeof MATERIAL_CHECK_STATUSES)[number]

export const EXTERNAL_CHECK_STATUSES = [
  "未核验",
  "待人工核验",
  "人工查询记录匹配",
  "记录冲突",
  "未查到",
  "查询失败",
] as const
export type ExternalCheckStatus = (typeof EXTERNAL_CHECK_STATUSES)[number]

/** Human 外部真实性 statuses that must never be treated as a pass. */
export const EXTERNAL_NOT_PASS_STATUSES: readonly ExternalCheckStatus[] = [
  "未核验",
  "待人工核验",
  "记录冲突",
  "未查到",
  "查询失败",
]

export const EXTERNAL_RECORD_CONCLUSIONS = ["matched", "conflict", "not_found", "query_failed", "pending"] as const
export type ExternalRecordConclusion = (typeof EXTERNAL_RECORD_CONCLUSIONS)[number]

/** Append-only manual external-verification record as returned to clients. */
export type VerificationExternalRecordView = {
  recordId: string
  requirementSetVersionId: string
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: ExternalRecordConclusion
  proofMaterialVersionId: string
  sha256: string
  createdAt: string
}

/** Pinned external record snapshot embedded in a comparison result. */
export type ExternalRecordSnapshot = {
  recordId: string
  sha256: string
  /** Requirement this manual query answers; records for another requirement never apply. */
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: ExternalRecordConclusion
  proofMaterialVersionId: string
}

/** One compared material version pinned by the task manifest. */
export type MaterialSnapshot = {
  materialId: string
  versionId: string
  sha256: string
}

/** Requirement fields snapshotted inside the comparison result (no DB access on export). */
export type RequirementSnapshot = {
  requirementId: string
  /** 义务主体; a matched external record must bind to it as well as to the certificate evidence. */
  subject: string
  quote: string
  source: RequirementSource
  materialVersionId: string
  nature: RequirementNatureValue
  field: VerificationFieldKey | null
  operator: ComparisonOperator | null
  value: string | string[] | null
  asOfRule: RequirementAsOfRule
  addendumState: AddendumState
  materialRelation: string
  /** Single-level AND/OR expression when the requirement is not a plain field comparison. */
  group: RequirementGroup | null
}

/** Evidence field value copied from the C4-OCR/manual field store. */
export type VerificationEvidence = {
  fieldKey: VerificationFieldKey
  valueText: string
  normalizedValue: string
  origin: "ocr" | "manual" | "material_text"
  /** OCR confidence 0—100; null for manual/material-text values. Low confidence never satisfies a requirement. */
  confidence: number | null
  subjectKey: string
  materialVersionId: string
}

export type VerificationItem = {
  requirementId: string
  materialCheck: MaterialCheckStatus
  externalCheck: ExternalCheckStatus
  detail: string
  evidence: VerificationEvidence[]
}

export type VerificationCoverage = {
  requirements: number
  /** requirements with a determinate material check (not 待确认). */
  compared: number
  materialSatisfied: number
  materialMissing: number
  fieldConflict: number
  dateUnsatisfied: number
  pending: number
  externalMatched: number
  externalUnverified: number
  externalOther: number
}

export type VerificationUnfinished = {
  requirementId: string
  reason: string
}

/** Immutable `bid-verification` result value (machine baseline, no model calls). */
export type BidVerificationValue = {
  schemaVersion: 1
  status: "success" | "partial"
  /** 判定时点; required, never defaulted to "today". */
  asOf: string
  requirementSet: {
    id: string
    versionId: string
    sha256: string
    requirements: RequirementSnapshot[]
  }
  materials: MaterialSnapshot[]
  records: ExternalRecordSnapshot[]
  items: VerificationItem[]
  coverage: VerificationCoverage
  unfinished: VerificationUnfinished[]
  warnings: string[]
  errors: Array<{ code: string; message: string }>
}

/** Server-computed stale hint for a saved comparison version. */
export type VerificationStaleState = {
  records: boolean
  fields: boolean
  hint: string | null
}

/** GET /api/projects/[id]/verifications item. */
export type VerificationListSummary = {
  resultId: string
  kind: "bid-requirements" | "bid-verification"
  versionId: string
  sha256: string
  createdAt: string
  createdBy: string
  origin: string
  validation: { status: "valid" | "partial" | "invalid"; issues: Array<{ code: string; message: string }> }
  review: { decision: "approved" | "rejected" | "changes_requested" } | null
  stale: VerificationStaleState
  summary: {
    asOf?: string
    status?: "candidate" | "confirmed" | "success" | "partial"
    requirementCount: number
    pendingCount?: number
    materialSatisfied?: number
    externalMatched?: number
    unfinished?: number
  }
}

/** The two result kinds owned by the C4 verification package. */
export const VERIFICATION_RESULT_KINDS = ["bid-requirements", "bid-verification"] as const
export type VerificationResultKind = (typeof VERIFICATION_RESULT_KINDS)[number]

export function isVerificationResultKind(kind: string): kind is VerificationResultKind {
  return (VERIFICATION_RESULT_KINDS as readonly string[]).includes(kind)
}
