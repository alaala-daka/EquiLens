export type FactNature = "材料记载" | "人工陈述" | "拟约定" | "程序计算"
export type FactConfirmation = "未确认" | "已确认" | "待核实"
export type FactSupport = "材料支持" | "仅人工陈述" | "材料冲突" | "缺少支持"

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

/** Project material anchor; legacy document anchors remain supported by the anonymous domain. */
export type SourceAnchor = {
  projectId: string
  quote: string
  parseSnapshotId: string
  locator?: string
  fragmentId?: string
  paragraphIndex?: number
  materialId?: string
  materialVersionId?: string
  documentId?: string
  documentVersionId?: string
}

export type FactInput = {
  projectId: string
  contractId?: string
  subject?: string
  field: string
  occurredAt?: string
  periodStart?: string
  periodEnd?: string
  nature: FactNature
  originalValue?: string
  candidates?: string[]
  selectedValue?: string
  unit?: string
  caliber?: string
  sources: SourceAnchor[]
  conflicts: SourceAnchor[]
  confirmation: FactConfirmation
  support: FactSupport
  createdBy: string
  reason?: string
}

export type FactVersion = FactInput & {
  factId: string
  factVersionId: string
  version: number
  supersedesVersionId?: string
  sha256: string
  createdAt: string
  /** 人工确认不清除材料冲突；该字段表示当前证据状态。 */
  evidenceStatus: FactSupport
}

export type ProjectFactDraft = Omit<FactInput, "projectId" | "createdBy">
export type ProjectFactVersion = FactVersion
export type SaveProjectFact = {
  operationId: string
  factId?: string
  baseVersionId: string
  reason: string
  value: ProjectFactDraft
}

export class FactError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "FactError" }
}
