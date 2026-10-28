import type { EvidenceItem, EvidenceReport, EvidenceReportInput } from "@/lib/evidence/types"
import { EvidenceError } from "@/lib/evidence/types"
import { validateReportInput } from "./validation"

const quote = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[|]/g, "\\|")
const linkLabel = (item: EvidenceItem) => {
  const labels = item.links.map(link => link.kind === "fact" ? "事实 " + link.factId : link.kind === "payment" ? "款项行 " + link.rowId
    : link.kind === "clause" ? "条款来源" : "争点 " + link.disputeId)
  if (item.pendingLinks?.length) labels.push("待关联：" + item.pendingLinks.join("、"))
  return labels.length ? labels.join("；") : "无关联"
}

export function composeEvidenceReport(input: EvidenceReportInput): Omit<EvidenceReport, "reportId" | "revisionId" | "sha256" | "createdAt"> {
  validateReportInput(input)
  const conflicts = input.items.filter(item => item.support === "材料冲突")
  const pending = input.items.filter(item => item.confirmation === "待核实")
  const unsupported = input.items.filter(item => item.support === "缺少支持" || item.support === "仅人工陈述")
  const unlinked = input.items.filter(item => item.pendingLinks?.length)
  const openGaps = input.gaps.filter(item => item.status === "开放")
  const status = conflicts.length || pending.length || openGaps.length || unlinked.length ? "incomplete" : "draft"
  const scopeNotes: string[] = []
  if (conflicts.length) scopeNotes.push(`${conflicts.length} 项证据存在材料冲突，冲突状态不因人工确认而清除。`)
  if (pending.length) scopeNotes.push(`${pending.length} 项事实仍待核实，不能视为已确认。`)
  if (openGaps.length) scopeNotes.push(`${openGaps.length} 项证据缺口尚未补正。`)
  if (unlinked.length) scopeNotes.push(`${unlinked.length} 项证据尚未关联事实、款项、条款或争点。`)
  if (unsupported.length) scopeNotes.push(`${unsupported.length} 项仅为人工陈述或缺少材料支持。`)
  return { projectId: input.projectId, contractId: input.contractId, baseRevisionId: input.baseRevisionId, cutoff: input.cutoff,
    status, reviewStatus: "待复核", scopeNotes, items: input.items, timeline: [...input.timeline].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    disputes: input.disputes, gaps: input.gaps, suggestions: input.suggestions, createdBy: input.createdBy }
}

export function evidenceReportMarkdown(report: EvidenceReport) {
  const lines = ["# 证据整理报告", "", `- 项目：${report.projectId}`, report.contractId ? `- 合同：${report.contractId}` : "- 合同：未指定",
    `- 核对截止日：${report.cutoff}`, `- 报告版本：${report.revisionId}`, `- 状态：${report.status === "incomplete" ? "未完成（存在冲突、缺证或待核实项）" : "草稿，待人工复核"}`,
    "", "> 本报告为人工整理的争议分析草稿，不构成法院认定事实或胜诉率判断；金额与事实须人工复核。", ""]
  if (report.scopeNotes.length) { lines.push("## 范围与未核实事项", "", ...report.scopeNotes.map(note => "- " + note), "") }
  lines.push("## 时间线", "", "| 日期 | 事件 | 证据版本 |", "| --- | --- | --- |")
  for (const event of report.timeline) lines.push(`| ${event.at} | ${quote(event.title + (event.detail ? "：" + event.detail : ""))} | ${event.evidenceVersionIds.join("、")} |`)
  if (!report.timeline.length) lines.push("| — | 尚未整理时间线 | — |")
  lines.push("", "## 争点", "")
  for (const dispute of report.disputes) lines.push(`### ${dispute.title}`, "", `- 确认状态：${dispute.status}`,
    dispute.claimAmountFen ? `- 争议主张金额（分）：${dispute.claimAmountFen}（争议主张，不计入已确认金额）` : "- 未登记争议主张金额",
    `- 证据版本：${dispute.evidenceVersionIds.join("、") || "尚未关联"}`, dispute.note ? `- 说明：${quote(dispute.note)}` : "", "")
  if (!report.disputes.length) lines.push("尚未登记争点。", "")
  lines.push("## 证据对应表", "", "| 证据版本 | 标题 | 类型 | 证据状态 | 确认状态 | 关联对象 |", "| --- | --- | --- | --- | --- | --- |")
  for (const item of report.items) lines.push(`| ${item.versionId} | ${quote(item.title)} | ${item.kind} | ${item.support} | ${item.confirmation} | ${quote(linkLabel(item))} |`)
  lines.push("", "## 缺证项", "")
  if (report.gaps.length) for (const gap of report.gaps) lines.push(`- [${gap.status}] ${quote(gap.description)}`)
  else lines.push("未登记缺证项；这不表示证据已经充分。")
  lines.push("", "## 有条件建议", "")
  if (report.suggestions.length) for (const suggestion of report.suggestions) lines.push(`- ${quote(suggestion.text)}（依赖证据：${suggestion.dependsOnVersionIds.join("、") || "无"}）`)
  else lines.push("尚未形成建议。")
  lines.push("", "## 来源引文", "")
  for (const item of report.items) {
    const sources = [...item.sources, ...item.conflicts]
    if (!sources.length) continue
    lines.push(`### ${item.title}`, "")
    for (const source of sources) lines.push(`- 第 ${source.paragraphIndex === undefined ? "?" : source.paragraphIndex + 1} 段${source.locator ? "（" + quote(source.locator) + "）" : ""}：${quote(source.quote)}`)
    lines.push("")
  }
  lines.push("---", `版本摘要：${report.sha256}`, `导出时间：${report.createdAt}`, "")
  return lines.join("\n")
}

export function assertReportCanBeMarkedComplete(report: EvidenceReport) {
  if (report.status !== "incomplete") return
  throw new EvidenceError("EVIDENCE_REPORT_INCOMPLETE", "报告存在冲突、缺证或待核实项，不能标记为完整。")
}
