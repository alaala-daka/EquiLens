export type DocumentTaskKind = "payment-reconciliation" | "evidence-organization" | "collection-letter"
export const documentTaskLabels = { "contract-review": "合同审查", "payment-reconciliation": "款项核对", "evidence-organization": "证据整理", "collection-letter": "催款函" } as const
export type LetterPlan = { sender: string; recipient: string; contractTitle: string; demand: string; plannedDate: string; method: string; address: string }
export type CollectionLetter = { templateVersion: "collection-letter-v1"; title: string; paragraphs: string[]; missing: string[]; auditPassed: boolean
  export?: { sha256: string; renderVersion: string; draftSha256: string; attempt: number; filename: string } }
export type Citation = { paragraphIndex: number; quote: string }
export type AmountItem = {
  label: string; kind: "计量" | "计付基数" | "净应付" | "付款" | "扣项" | "未到期" | "争议" | "材料余额"
  amountYuan: string; rawAmount: string; source: Citation
  payer: string | null; payee: string | null; scope: string; taxBasis: "含税" | "不含税" | "不明"
  basis: "本期" | "累计" | "不明"; periodStart: string | null; periodEnd: string | null; eventDate: string | null
  dueDate: string | null; dueEvidence: Citation | null; conditionMet: boolean | null
  ratio: string | null; rawRatio: string | null; ratioEvidence: Citation | null
}
export type EvidenceEvent = {
  title: string; date: string | null; detail: string; nature: "材料记载" | "经办人陈述" | "拟约定"
  support: "材料支持" | "材料冲突" | "支持不足"; sources: Citation[]; conflicts: Citation[]
}
export type DocumentExtraction = {
  notes?: string[]
  overview: string; coverage: "完整" | "部分"; paymentCoverage: boolean
  amounts: AmountItem[]; terms: { title: string; detail: string; sources: Citation[] }[]
  events: EvidenceEvent[]; disputes: { title: string; detail: string; eventIndexes: number[] }[]; gaps: string[]
}
export type DocumentAnalysis = {
  letter?: CollectionLetter
  version: "document-agent-v1"; task: DocumentTaskKind; cutoff: string
  skill: { id: string; version: string; sha256: string }; extraction: DocumentExtraction | null
  rejected: { id: string; reason: string }[]
  audit: { complete: boolean; checks: { id: string; accepted: boolean; reason: string }[]; gaps: string[]; notes?: string[] }
  calculation: { netDueFen: string; paidFen: string; unpaidFen: string; formula: string } | null
  calculationNotes: string[]; reviewStatus: "待人工复核"
}
