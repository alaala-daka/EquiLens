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

/**
 * 与共享来源契约对齐：全部绑定不可变版本与解析快照。
 *
 * 项目主线（第八轮）使用项目材料版本 `materialId/materialVersionId`；
 * 匿名文档 Agent 增量使用 `documentId/documentVersionId`。二者二选一，
 * 由 `parseSnapshotId` 与片段/段落定位到原文。
 */
export type SourceRef = {
  projectId: string
  quote: string
  parseSnapshotId: string
  materialId?: string
  materialVersionId?: string
  documentId?: string
  documentVersionId?: string
  fragmentId?: string
  paragraphIndex?: number
  locator?: string
}

export type EvidenceLink =
  | { kind: "fact"; factId: string; factVersionId: string }
  | { kind: "payment"; ledgerRevisionId: string; rowId: string; resultId?: string }
  | { kind: "clause"; source: SourceRef }
  | { kind: "dispute"; evidenceReportRevisionId: string; disputeId: string; resultId?: string }

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

/** 项目证据报告成果 value（第八轮）。状态与范围说明由服务端派生，浏览器不得提交。 */
export type EvidenceReportValue = {
  schemaVersion: 1
  cutoff: string
  contractId?: string
  status: "draft" | "incomplete"
  scopeNotes: string[]
  items: EvidenceItem[]
  timeline: TimelineEventInput[]
  disputes: DisputeInput[]
  gaps: EvidenceGapInput[]
  suggestions: EvidenceSuggestionInput[]
}

/** 保存证据项：首次保存 baseVersionId 为空字符串，人工更正必须等于当前最新版本。 */
export type EvidenceItemDraft = Omit<EvidenceItemInput, "projectId" | "createdBy">
export type SaveEvidenceItem = {
  operationId: string
  itemId?: string
  baseVersionId: string
  reason: string
  value: EvidenceItemDraft
}

/** 报告只引用已保存的证据项版本；状态、范围说明与报告条目由服务端组装。 */
export type EvidenceReportDraft = {
  cutoff: string
  contractId?: string
  itemVersionIds: string[]
  timeline: TimelineEventInput[]
  disputes: DisputeInput[]
  gaps: EvidenceGapInput[]
  suggestions: EvidenceSuggestionInput[]
}

export type SaveEvidenceReport = {
  operationId: string
  reason: string
  baseVersionId: string
  value: EvidenceReportDraft
}

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EvidenceError" }
}
