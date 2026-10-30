import { BusinessError } from "../projects/errors"
import type { ResultView } from "../results/service"
import { evidenceReportMarkdown } from "./report"
import { parseEvidenceReportValue } from "./result-validator"

/** 只读所选保存版本的 Markdown 正文（与 Word 同结构、同状态，不重新生成事实）。 */
export function evidenceReportMarkdownFromView(view: ResultView): string {
  const value = parseEvidenceReportValue(view.value)
  if (!value) throw new BusinessError("INVALID_INPUT", "证据报告校验未通过。")
  return evidenceReportMarkdown({ ...value, projectId: view.projectId, reportId: view.resultId, revisionId: view.versionId,
    sha256: view.sha256, createdAt: view.createdAt, createdBy: view.createdBy, reviewStatus: "待复核" })
}

const yuan = (fen: string) => {
  const value = BigInt(fen), negative = value < BigInt(0), absolute = negative ? -value : value
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`
}

/**
 * `evidence-report-v1` 导出正文：只读所选保存版本，正文与 Markdown 同结构。
 * 冲突、待核实、开放缺口与待关联事项持续显示，不因复核清除。
 */
export const evidenceReportExportTemplate = {
  version: "evidence-report-v1",
  blocksInvalidResult: true,
  paragraphs(raw: unknown): string[] {
    const value = parseEvidenceReportValue(raw)
    if (!value) throw new BusinessError("INVALID_INPUT", "证据报告校验未通过。")
    const lines = ["项目证据整理报告", `核对截止日：${value.cutoff}`, `合同：${value.contractId ?? "未指定"}`,
      `状态：${value.status === "incomplete" ? "未完成（存在冲突、缺证或待核实项）" : "草稿，待人工复核"}`]
    if (value.scopeNotes.length) { lines.push("范围与未核实事项："); for (const note of value.scopeNotes) lines.push(`- ${note}`) }
    lines.push("时间线：")
    if (!value.timeline.length) lines.push("尚未整理时间线。")
    value.timeline.forEach((event, index) => lines.push(`${index + 1}. ${event.at} ${event.title}${event.detail ? `：${event.detail}` : ""}（证据版本：${event.evidenceVersionIds.join("、") || "无"}）`))
    lines.push("争点：")
    if (!value.disputes.length) lines.push("尚未登记争点。")
    value.disputes.forEach((dispute, index) => lines.push(`${index + 1}. ${dispute.title}（${dispute.status}）${dispute.claimAmountFen ? `；争议金额 ${yuan(dispute.claimAmountFen)} 元` : ""}${dispute.note ? `；${dispute.note}` : ""}`))
    lines.push(`证据对应（${value.items.length} 项）：`)
    value.items.forEach((item, index) => lines.push(`${index + 1}. ${item.kind} · ${item.title}（${item.support} / ${item.confirmation}）${item.occurredAt ? `；${item.occurredAt}` : ""}${item.pendingLinks?.length ? `；待关联：${item.pendingLinks.join("、")}` : ""}`))
    lines.push(`缺证项（${value.gaps.length} 项）：`)
    if (!value.gaps.length) lines.push("暂无登记的缺证项。")
    value.gaps.forEach((gap, index) => lines.push(`${index + 1}. ${gap.description}（${gap.status}）`))
    lines.push("有条件建议：")
    if (!value.suggestions.length) lines.push("暂无建议。")
    value.suggestions.forEach((suggestion, index) => lines.push(`${index + 1}. ${suggestion.text}`))
    lines.push("本报告为人工整理草稿；材料冲突、待核实与缺证项不因复核而清除，不构成法院认定事实或胜诉判断。")
    return lines
  },
}
