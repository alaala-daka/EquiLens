import type { Finding, ReviewResult } from "./types"

const severityOrder: Record<Finding["severity"], number> = { 重大关注: 0, 一般关注: 1, 提示: 2 }
const plain = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}<>|]/g, "\\$&")

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.paragraphIndex - b.paragraphIndex)
}
export function toJson(result: ReviewResult): string { return JSON.stringify(result, null, 2) }

export function toMarkdown(result: ReviewResult): string {
  const lines = [
    "# 合同审查报告：" + plain(result.documentTitle), "",
    "- 结果 ID：" + result.reviewId,
    "- 时间：" + result.createdAt,
    "- 执行状态：" + result.status,
    "- 模式：" + (result.mode === "debug" ? "开发调试，资料未核对，不形成正式法律结论" : "已发布规则"),
    "- 规则包版本：" + plain(result.packVersion),
    "- 输入文字 SHA-256：" + result.input.textSha256,
    "- 输入完整：" + (result.input.complete ? "是（调用方声明的解析范围）" : "否"),
    "- 模型：" + plain(result.model),
    "- 模型调用预算占用：" + result.callsUsed,
    "",
  ]
  if (result.usage) lines.push("- Token 用量：" + result.usage.totalTokens, "")
  for (const warning of result.warnings) lines.push("> " + plain(warning), "")
  lines.push("## 检查覆盖", "", "| 检查类别 | 状态 | 说明 |", "| --- | --- | --- |")
  for (const item of result.coverage) lines.push("| " + item.category + " | " + item.status + " | " + plain(item.note) + " |")
  const issues = sortFindings(result.findings.filter(item => item.kind === "发现问题" || item.kind === "缺失条款"))
  lines.push("", "## 发现问题与缺失条款（" + issues.length + "）", "")
  if (!issues.length) lines.push(
    result.status === "success" && result.coverage.every(item => item.status === "未发现问题")
      ? "声明范围内的必要检查已完成，未发现问题，仍须人工复核。"
      : "尚未形成完整的无风险结论；请查看待核实、未覆盖及失败记录。",
    "",
  )
  for (const item of issues) {
    lines.push("### [" + item.severity + "] " + plain(item.ruleId) + " · " + item.kind, "",
      "- 风险：" + plain(item.risk),
      "- 位置：" + (item.kind === "缺失条款" ? "所提供的完整检查范围，未找到必要约定" : "第 " + (item.paragraphIndex + 1) + " 段"))
    if (item.quote) lines.push("- 原文：" + plain(item.quote))
    lines.push("- 依据：" + plain(item.basis.join("、")), "- 影响：" + plain(item.impact),
      "- 建议：" + plain(item.suggestion), "- 复核状态：" + item.reviewStatus, "")
  }
  lines.push("## 待核实与未完成", "")
  const unresolved = result.findings.filter(item => item.kind === "待核实")
  for (const item of unresolved) lines.push("- " + plain(item.ruleId + "：" + item.pending.join("；")))
  for (const item of result.coverage.filter(item => ["未覆盖", "待核实"].includes(item.status))) lines.push("- " + item.category + "：" + plain(item.note))
  for (const error of result.errors) lines.push("- " + error.code + "：" + error.message + "（" + plain(error.ruleIds.join("、")) + "）")
  if (result.status === "success" && !unresolved.length) lines.push("本次声明检查范围无待核实项，全部结论仍待人工复核。")
  if (result.rejected.length) {
    lines.push("", "## 被拒绝或缺少的结论", "")
    for (const item of result.rejected) lines.push("- " + plain(item.ruleId + "：" + item.reason + "；" + item.detail))
  }
  lines.push("", "> 本报告由 AI 辅助生成，所有结论均待人工复核；引用校验通过不代表法律适用正确。", "")
  return lines.join("\n")
}
