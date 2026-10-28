import { docxFromParagraphs } from "@/lib/documents/docx"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { CATEGORY_LABELS, getReportView } from "../../../tools/contract-review/src/presentation"

const clean = (value: string) => value.replace(/\s+/g, " ").trim()
export function reportDocxParagraphs(result: ReviewResult): string[] {
  const view = getReportView(result)
  const scene = result.sceneCandidates?.find(item => item.id === result.sceneSelection?.sceneId)?.label ?? "合同审查"
  const paragraphs = ["合同审查报告", result.documentTitle, scene + " · 审查立场：" + (result.input.context.role ?? "未确认"),
    view.summary, view.outcomeNotice, ...view.scopeNotes, ""]
  if (view.groups.length) paragraphs.push("审查发现")
  for (const group of view.groups) {
    paragraphs.push(CATEGORY_LABELS[group.category])
    for (const finding of group.findings) {
      paragraphs.push(`${finding.severity} · ${finding.risk}`, `风险影响：${finding.impact || "未说明"}`, `修改建议：${finding.suggestion || "未说明"}`)
      if (finding.quote) paragraphs.push(`原文：${finding.quote}`)
    }
  }
  if (view.unfinished.length) {
    paragraphs.push("", "尚未完成的检查")
    for (const item of view.unfinished) paragraphs.push(`${item.ruleId}：${item.detail}`)
  }
  if (result.collaboration?.audit) {
    paragraphs.push("", "AI 复查", `状态：${result.collaboration.audit.status === "completed" ? "已完成" : "未完成"}`,
      `已核对 ${result.collaboration.audit.checks.length} / ${result.findings.length} 条`)
    for (const check of result.collaboration.audit.checks) paragraphs.push(`${check.ruleId} · ${check.outcome}：${check.note}`)
  }
  paragraphs.push("", result.mode === "debug" ? "依据尚未核对，仅供联调，需专业人员审核。" : "AI 辅助审查，结论需人工复核；引文真实不代表法律适用正确。")
  return paragraphs.map(clean).filter((value, index) => value || index > 0)
}
export async function reportDocx(result: ReviewResult): Promise<Blob> {
  return docxFromParagraphs(reportDocxParagraphs(result))
}
