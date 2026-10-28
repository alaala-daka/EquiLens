import type { EvidenceItemInput, EvidenceReportInput, SourceRef } from "@/lib/evidence/types"

/** 测试用来源/事实/款项解析器；生产接入共享服务后替换。 */
export function testScope(options: { projectId: string; documents?: string[]; facts?: string[]; payments?: string[]; disputes?: string[] }) {
  const known = (list: string[] | undefined, value: string) => Boolean(list?.includes(value))
  return {
    hasDocumentSource: (projectId: string, source: SourceRef) => projectId === options.projectId && known(options.documents, source.documentVersionId),
    hasFact: (projectId: string, factId: string, factVersionId: string) => projectId === options.projectId && known(options.facts, factId + ":" + factVersionId),
    hasPayment: (projectId: string, ledgerRevisionId: string, rowId: string) => projectId === options.projectId && known(options.payments, ledgerRevisionId + ":" + rowId),
    hasDispute: (projectId: string, revisionId: string, disputeId: string) => projectId === options.projectId && known(options.disputes, revisionId + ":" + disputeId),
  }
}

export function normalCase(projectId = "project-normal"): { items: (EvidenceItemInput & { itemId: string })[]; report: Omit<EvidenceReportInput, "items"> } {
  const contract = "contract-1"
  const source = (documentId: string, documentVersionId: string, quote: string, paragraphIndex: number): SourceRef => ({
    projectId, documentId, documentVersionId, parseSnapshotId: "snapshot-" + documentVersionId, paragraphIndex, quote,
  })
  const items: (EvidenceItemInput & { itemId: string })[] = [
    { itemId: "item-contract", projectId, contractId: contract, kind: "材料事实", title: "合同约定进度款按 80% 支付",
      occurredAt: "2026-01-10", sources: [source("doc-contract", "doc-contract-v1", "进度款按经确认计量款的80%支付。", 3)],
      conflicts: [], confirmation: "已确认", support: "材料支持",
      links: [{ kind: "clause", source: source("doc-contract", "doc-contract-v1", "进度款按经确认计量款的80%支付。", 3) }],
      createdBy: "synthetic" },
    { itemId: "item-measure", projectId, contractId: contract, kind: "材料事实", title: "2026 年 3 月计量确认 100 万元",
      occurredAt: "2026-03-20", originalValue: "1000000", selectedValue: "1000000", unit: "元", caliber: "含税",
      sources: [source("doc-measure", "doc-measure-v1", "本期计量确认金额为人民币壹佰万元整。", 1)],
      conflicts: [], confirmation: "已确认", support: "材料支持",
      links: [{ kind: "fact", factId: "fact-measure", factVersionId: "fact-measure-v1" }], createdBy: "synthetic" },
    { itemId: "item-payment", projectId, contractId: contract, kind: "材料事实", title: "2026 年 4 月收到进度款 30 万元",
      occurredAt: "2026-04-15", originalValue: "300000", selectedValue: "300000", unit: "元", caliber: "含税",
      sources: [source("doc-payment", "doc-payment-v1", "收款金额人民币叁拾万元整，用途为进度款。", 0)],
      conflicts: [], confirmation: "已确认", support: "材料支持",
      links: [{ kind: "payment", ledgerRevisionId: "ledger-rev-1", rowId: "row-1" }], createdBy: "synthetic" },
    { itemId: "item-notice", projectId, contractId: contract, kind: "材料事实", title: "2026 年 5 月发出催告函",
      occurredAt: "2026-05-06", sources: [source("doc-notice", "doc-notice-v1", "请于收到本函后十日内支付已到期未付款项。", 2)],
      conflicts: [], confirmation: "已确认", support: "材料支持", links: [], createdBy: "synthetic" },
  ]
  return { items, report: { projectId, contractId: contract, cutoff: "2026-05-31",
    timeline: [
      { id: "t1", at: "2026-01-10", title: "合同签订", evidenceVersionIds: [] },
      { id: "t2", at: "2026-03-20", title: "计量确认", evidenceVersionIds: [] },
      { id: "t3", at: "2026-04-15", title: "收到进度款", evidenceVersionIds: [] },
      { id: "t4", at: "2026-05-06", title: "发出催告函", evidenceVersionIds: [] },
    ],
    disputes: [{ id: "d1", title: "已到期未付进度款", claimAmountFen: "5000000", evidenceVersionIds: [], status: "已确认" }],
    gaps: [], suggestions: [{ id: "s1", text: "补齐付款凭证与到期依据后，可发出有条件催款函。", dependsOnVersionIds: [] }],
    createdBy: "synthetic" } }
}

export function conflictCase(projectId = "project-conflict"): { items: (EvidenceItemInput & { itemId: string })[]; report: Omit<EvidenceReportInput, "items"> } {
  const source = (documentId: string, quote: string): SourceRef => ({ projectId, documentId, documentVersionId: documentId + "-v1",
    parseSnapshotId: "snapshot-" + documentId + "-v1", paragraphIndex: 0, quote })
  const items: (EvidenceItemInput & { itemId: string })[] = [
    { itemId: "item-payment-duplicate", projectId, kind: "材料事实", title: "同一笔 30 万元进度款出现两份凭证",
      sources: [source("doc-payment-a", "收款金额人民币叁拾万元整。")],
      conflicts: [source("doc-payment-b", "收款金额人民币叁拾万元整，凭证编号不同。")],
      confirmation: "已确认", support: "材料冲突", links: [], pendingLinks: ["payment"], createdBy: "synthetic" },
  ]
  return { items, report: { projectId, cutoff: "2026-05-31",
    timeline: [{ id: "t1", at: "2026-04-15", title: "付款凭证冲突", evidenceVersionIds: [] }],
    disputes: [{ id: "d1", title: "已到期未付进度款", claimAmountFen: "7000000", evidenceVersionIds: [], status: "待核实" }],
    gaps: [{ id: "g1", description: "缺少到期依据及付款归属确认。", status: "开放" as const }],
    suggestions: [], createdBy: "synthetic" } }
}
