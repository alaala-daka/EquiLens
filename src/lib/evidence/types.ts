/**
 * 证据整理的领域类型。
 * 项目、事实、款项和来源的正式类型由共享契约提供；此处按其草案使用不可变 ID 引用，
 * 共享类型落地后只替换类型来源，不改变字段语义。
 */
export const EVIDENCE_ITEM_KINDS = ["材料事实", "人工陈述", "拟约定", "程序计算"] as const
export const CONFIRMATION_STATUSES = ["未确认", "已确认", "待核实"] as const
export const EVIDENCE_SUPPORTS = ["材料支持", "仅人工陈述", "材料冲突", "缺少支持"] as const

export type EvidenceItemKind = (typeof EVIDENCE_ITEM_KINDS)[number]
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number]
export type EvidenceSupport = (typeof EVIDENCE_SUPPORTS)[number]

/** 与共享来源契约对齐：全部绑定不可变文档版本与解析快照。 */
export type SourceRef = {
  projectId: string
  documentId: string
  documentVersionId: string
  parseSnapshotId: string
  fragmentId?: string
  paragraphIndex?: number
  quote: string
  locator?: string
}

export type EvidenceLink =
  | { kind: "fact"; factId: string; factVersionId: string }
  | { kind: "payment"; ledgerRevisionId: string; rowId: string }
  | { kind: "clause"; source: SourceRef }
  | { kind: "dispute"; evidenceReportRevisionId: string; disputeId: string }

export type EvidencePeriod = { start?: string; end?: string }

export type EvidenceItemInput = {
  projectId: string
  contractId?: string
  kind: EvidenceItemKind
  title: string
  occurredAt?: string
  period?: EvidencePeriod
  originalValue?: string
  candidates?: string[]
  selectedValue?: string
  unit?: string
  caliber?: string
  sources: SourceRef[]
  conflicts: SourceRef[]
  confirmation: ConfirmationStatus
  support: EvidenceSupport
  links: EvidenceLink[]
  /** 尚未关联的对象明确保留，不填写占位 ID。 */
  pendingLinks?: ("fact" | "payment" | "clause" | "dispute")[]
  note?: string
  reason?: string
  createdBy: string
}

export type EvidenceItem = EvidenceItemInput & {
  itemId: string
  versionId: string
  supersedesVersionId?: string
  sha256: string
  createdAt: string
}

export type TimelineEventInput = {
  id: string
  at: string
  title: string
  detail?: string
  evidenceVersionIds: string[]
}

export type DisputeInput = {
  id: string
  title: string
  claimAmountFen?: string
  evidenceVersionIds: string[]
  status: ConfirmationStatus
  note?: string
}

export type EvidenceGapInput = {
  id: string
  description: string
  relatedDisputeId?: string
  status: "开放" | "已补正"
}

export type EvidenceSuggestionInput = {
  id: string
  text: string
  dependsOnVersionIds: string[]
}

export type EvidenceReportInput = {
  projectId: string
  contractId?: string
  cutoff: string
  items: EvidenceItem[]
  timeline: TimelineEventInput[]
  disputes: DisputeInput[]
  gaps: EvidenceGapInput[]
  suggestions: EvidenceSuggestionInput[]
  createdBy: string
  reportId?: string
  baseRevisionId?: string
}

export type EvidenceReport = {
  reportId: string
  revisionId: string
  projectId: string
  contractId?: string
  baseRevisionId?: string
  cutoff: string
  status: "draft" | "incomplete"
  reviewStatus: "待复核"
  scopeNotes: string[]
  items: EvidenceItem[]
  timeline: TimelineEventInput[]
  disputes: DisputeInput[]
  gaps: EvidenceGapInput[]
  suggestions: EvidenceSuggestionInput[]
  createdBy: string
  sha256: string
  createdAt: string
}

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EvidenceError" }
}
