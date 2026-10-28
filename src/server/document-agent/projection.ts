import type { DocumentAnalysis } from "@/lib/document-agent/types"
import type { FactInput, SourceRef } from "@/lib/facts/types"
import type { LedgerRow } from "@/lib/payments/types"
import type { FactRepository } from "@/server/facts/repository"
import type { PaymentLedgerRepository } from "@/server/payments/repository"

type DocumentRef = { documentId: string; documentVersionId: string; parseSnapshotId: string }

const fen = (yuan: string) => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(yuan)
  if (!match) throw new Error("金额格式无效。")
  return (BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"))).toString()
}
const source = (projectId: string, document: DocumentRef, citation: { paragraphIndex: number; quote: string } | null | undefined): SourceRef | undefined =>
  citation ? { projectId, documentId: document.documentId, documentVersionId: document.documentVersionId, parseSnapshotId: document.parseSnapshotId,
    paragraphIndex: citation.paragraphIndex, quote: citation.quote } : undefined

/**
 * 将文档 Agent 的整理结果投影到共享事实和款项版本。
 * projectId 必须由项目上下文提供；这里不接受匿名 owner 冒充项目。
 */
export async function projectDocumentAnalysis(options: {
  projectId: string; analysis: DocumentAnalysis; document: DocumentRef; taskId: string; createdBy: string
  facts: FactRepository; ledgers: PaymentLedgerRepository
}) {
  const { projectId, analysis, document, taskId, createdBy, facts, ledgers } = options
  const data = analysis.extraction
  if (!data) throw new Error("整理结果为空，无法投影。")
  const accepted = (id: string) => analysis.audit.checks.some(check => check.id === id && check.accepted) ? "已确认" as const : "待核实" as const
  const factRefs: { factId: string; factVersionId: string }[] = []
  const saveFact = async (input: FactInput) => {
    const saved = await facts.save(projectId, input)
    factRefs.push({ factId: saved.factId, factVersionId: saved.factVersionId })
    return saved.factVersionId
  }

  if (analysis.task === "payment-reconciliation" || analysis.task === "evidence-organization") {
    for (const [index, item] of data.amounts.entries()) {
      const itemSource = source(projectId, document, item.source)
      if (!itemSource) continue
      const factVersionId = await saveFact({ projectId, contractId: undefined, field: item.label, occurredAt: item.eventDate ?? undefined,
        periodStart: item.periodStart ?? undefined, periodEnd: item.periodEnd ?? undefined, nature: "材料记载", originalValue: item.rawAmount,
        selectedValue: item.amountYuan, unit: "元", caliber: item.taxBasis, sources: [itemSource], conflicts: [],
        confirmation: accepted("amount:" + index), support: "材料支持", createdBy, reason: "由文档 Agent 整理结果投影" })
      ;(item as typeof item & { factVersionId?: string }).factVersionId = factVersionId
    }
  }

  if (analysis.task === "evidence-organization") {
    for (const [index, event] of data.events.entries()) {
      const sources = event.sources.map(citation => source(projectId, document, citation)).filter((value): value is SourceRef => Boolean(value))
      const conflicts = event.conflicts.map(citation => source(projectId, document, citation)).filter((value): value is SourceRef => Boolean(value))
      if (!sources.length) continue
      await saveFact({ projectId, field: "证据事件：" + event.title, occurredAt: event.date ?? undefined, nature: event.nature === "经办人陈述" ? "人工陈述" : "材料记载",
        originalValue: event.detail, selectedValue: event.detail, sources, conflicts, confirmation: accepted("event:" + index),
        support: conflicts.length ? "材料冲突" : event.support === "支持不足" ? "缺少支持" : "材料支持", createdBy, reason: "由证据整理结果投影" })
    }
  }

  if (analysis.task === "payment-reconciliation") {
    const rows: LedgerRow[] = data.amounts.map((item, index) => {
      const itemSource = source(projectId, document, item.source)
      return { rowId: "row-" + (index + 1), nature: item.kind, amountFen: fen(item.amountYuan), taxBasis: item.taxBasis,
        basis: item.basis, periodStart: item.periodStart ?? undefined, periodEnd: item.periodEnd ?? undefined,
        eventDate: item.eventDate ?? undefined, dueDate: item.dueDate ?? undefined, conditionMet: item.conditionMet ?? undefined,
        ratio: item.ratio ?? undefined, payer: item.payer ?? undefined, payee: item.payee ?? undefined,
        confirmation: accepted("amount:" + index), ...(itemSource ? { source: itemSource } : {}),
        factVersionIds: factRefs.length > index ? [factRefs[index].factVersionId] : [] }
    })
    const ledger = await ledgers.save(projectId, { projectId, cutoff: analysis.cutoff, rows, facts: factRefs,
      createdBy, reason: "由款项核对任务 " + taskId + " 投影" })
    return { factVersionIds: factRefs.map(item => item.factVersionId), ledgerRevisionId: ledger.ledgerRevisionId }
  }
  return { factVersionIds: factRefs.map(item => item.factVersionId) }
}
