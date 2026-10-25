import type { Finding, ReviewResult } from "./types"
import { compactText, groupIssues, isCompleteNoRisk, sortFindings } from "./presentation"

const plain = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}<>|]/g, "\\$&")

export { sortFindings } from "./presentation"
export function toJson(result: ReviewResult): string { return JSON.stringify(result, null, 2) }

function findingDetails(item: Finding): string[] {
  const lines = ["- 完整结论：" + plain(item.risk),
    "- 位置：" + (item.kind === "缺失条款" ? "所提供的完整检查范围，未找到必要约定" : "第 " + (item.paragraphIndex + 1) + " 段")]
  if (item.quote) lines.push("- 原文：" + plain(item.quote))
  if (item.kind === "缺失条款") lines.push("- 已检查：" + (item.checkedParagraphIndexes?.length ?? 0) + " 段正文")
  for (const citation of item.citations ?? []) {
    if (citation.paragraphIndex === item.paragraphIndex && citation.quote === item.quote) continue
    lines.push("- 补充引文（第 " + (citation.paragraphIndex + 1) + " 段）：" + plain(citation.quote))
  }
  const references = item.sourceReferences?.map(source => source.sourceId + " " + source.type + "：" + source.name +
    (source.article ? " " + source.article : "") + (source.version ? " / " + source.version : ""))
  lines.push("- 依据：" + plain(references?.join("；") || item.basis.join("、")), "- 影响：" + plain(item.impact),
    "- 完整建议：" + plain(item.suggestion), "- 复核状态：" + item.reviewStatus)
  if (item.pending.length) lines.push("- 待核实：" + plain(item.pending.join("；")))
  return lines
}

export function toMarkdown(result: ReviewResult): string {
  const selection = result.sceneSelection
  const sceneLines: string[] = []
  if (selection) {
    const label = result.sceneCandidates?.find(item => item.id === selection.sceneId)?.label
    sceneLines.push("## 场景识别", "", "- 状态：" + (selection.status === "matched" ? "已匹配 · " + plain(label ?? selection.sceneId ?? "") : selection.status === "unsupported" ? "场景不支持" : "场景待确认"),
      "- 理由：" + plain(selection.reason), ...selection.missingInfo.map(item => "- 待补信息：" + plain(item)),
      ...selection.evidence.map(item => "- 原文（第 " + (item.paragraphIndex + 1) + " 段）：" + plain(item.quote)), "")
  }
  if (result.sceneCandidates && selection?.status !== "matched") return [
    "# 合同场景识别：" + plain(result.documentTitle), "", "- 执行状态：" + result.status,
    "- 结果 ID：" + result.reviewId, "- 输入文字 SHA-256：" + result.input.textSha256,
    "- 模型调用预算占用：" + result.callsUsed, "", ...sceneLines,
    ...(!selection ? ["场景识别未完成。", ""] : []),
    ...result.errors.map(item => "- " + item.code + "：" + item.message),
    "", "未执行合同审查。请核对合同类型或补充材料后重新审查。", "",
  ].join("\n")
  const lines = [
    "# 合同审查报告：" + plain(result.documentTitle), "",
    "- 执行状态：" + result.status,
    "- 模式：" + (result.mode === "debug" ? "开发调试，资料未核对，不形成正式法律结论" : "已发布规则"),
    "- 风险摘要：" + groupIssues(result.findings).reduce((count, group) => count + group.findings.length, 0) +
      " 项问题，" + result.findings.filter(item => item.kind === "待核实" || item.pending.length > 0).length + " 项待核实。",
    "", "> AI 辅助审查，所有结论均待人工复核；引用校验通过不代表法律适用正确。", "",
    "<details>", "<summary>报告记录与检查范围</summary>", "",
    "- 结果 ID：" + result.reviewId,
    "- 时间：" + result.createdAt,
    "- 规则包版本：" + plain(result.packVersion),
    "- 输入文字 SHA-256：" + result.input.textSha256,
    "- 输入完整：" + (result.input.complete ? "是（调用方声明的解析范围）" : "否"),
    "- 模型：" + plain(result.model),
    "- 模型调用预算占用：" + result.callsUsed,
    "",
  ]
  if (result.usage) lines.push("- Token 用量：" + result.usage.totalTokens, "")
  if (result.agent) {
    lines.push("- 执行方式：AI SDK Agent",
      "- 技能：" + plain(result.agent.skill.id + " / " + result.agent.skill.version),
      "- 已读正文：" + result.agent.readParagraphIndexes.length + " / " + result.paragraphs.length + " 段", "")
  }
  lines.push("</details>", "")
  lines.push(...sceneLines)
  if (result.collaboration) {
    const audit = result.collaboration.audit
    lines.push("## 独立复核", "", "- 流程：独立场景识别 → 场景主审 → 独立复核",
      "- 状态：" + (audit?.status ?? "尚未执行"), "- 已核对：" + (audit?.checks.length ?? 0) + " / " + result.findings.length,
      "- 需人工核对意见：" + (audit?.checks.filter(item => item.outcome === "需人工核对").length ?? 0),
      "- 机器意见不能修改主审原件或替代人工复核。", "")
    if (audit?.unreviewedRuleIds.length) lines.push("- 尚未复核：" + plain(audit.unreviewedRuleIds.join("、")), "")
    for (const rejected of audit?.rejected ?? []) lines.push("- 未采用复核意见：" + plain(rejected.ruleId + "：" + rejected.reason))
    for (const outcome of ["需人工核对", "保留"] as const) {
      const checks = audit?.checks.filter(item => item.outcome === outcome) ?? []
      if (!checks.length) continue
      lines.push("<details>", "<summary>" + outcome + "（" + checks.length + "）</summary>", "")
      for (const check of checks) lines.push("- " + plain(check.ruleId + "：" + check.note),
        ...(check.quote ? ["  原文（第 " + (check.paragraphIndex + 1) + " 段）：" + plain(check.quote)] : []))
      lines.push("", "</details>", "")
    }
  }
  if (!result.input.complete) lines.push("- 解析范围不完整，不能确认完整无风险或条款缺失。", "")
  if (result.agent && result.agent.readParagraphIndexes.length < result.paragraphs.length)
    lines.push("- 未读正文：" + (result.paragraphs.length - result.agent.readParagraphIndexes.length) + " 段。", "")
  for (const warning of result.warnings) lines.push("> " + plain(warning), "")
  for (const item of result.coverage.filter(item => ["未覆盖", "待核实"].includes(item.status)))
    lines.push("- " + item.category + " · " + item.status + "：" + plain(item.note))
  lines.push("", "<details>", "<summary>检查覆盖</summary>", "", "| 检查类别 | 状态 | 说明 |", "| --- | --- | --- |")
  for (const item of result.coverage) lines.push("| " + item.category + " | " + item.status + " | " + plain(item.note) + " |")
  lines.push("", "</details>", "")
  const groups = groupIssues(result.findings)
  lines.push("## 问题与修改建议", "")
  if (!groups.length) lines.push(
    isCompleteNoRisk(result)
      ? "声明范围内的必要检查已完成，未发现问题，仍须人工复核。"
      : "尚未形成完整的无风险结论；请查看待核实、未覆盖及失败记录。",
    "",
  )
  for (const group of groups) {
    const [first, ...rest] = group.findings
    lines.push("### " + group.category + "（" + group.findings.length + " 项）", "",
      "**优先关注 · " + first.severity + "**", "",
      "- 问题：" + plain(compactText(first.risk, 80)), "- 建议：" + plain(compactText(first.suggestion, 120)), "")
    lines.push("<details>", "<summary>优先项原文与详情</summary>", "", ...findingDetails(first), "", "</details>", "")
    if (rest.length) {
      lines.push("<details>", "<summary>其余 " + rest.length + " 项问题</summary>", "")
      for (const item of rest) lines.push("#### [" + item.severity + "] " + plain(item.ruleId), "", ...findingDetails(item), "")
      lines.push("</details>", "")
    }
  }
  lines.push("## 待核实与未完成", "")
  const unresolved = result.findings.filter(item => item.kind === "待核实" || item.pending.length > 0)
  for (const item of unresolved) lines.push("- " + plain(item.ruleId + "：" + (item.pending.join("；") || item.risk)))
  for (const error of result.errors) lines.push("- " + error.code + "：" + error.message + "（" + plain(error.ruleIds.join("、")) + "）")
  if (result.status === "success" && !unresolved.length) lines.push("本次声明检查范围无待核实项，全部结论仍待人工复核。")
  const clear = sortFindings(result.findings.filter(item => item.kind === "未发现问题"))
  if (clear.length) {
    lines.push("", "<details>", "<summary>未发现问题的结论（" + clear.length + "）</summary>", "")
    for (const item of clear) lines.push("### " + plain(item.ruleId), "", ...findingDetails(item), "")
    lines.push("</details>", "")
  }
  if (result.rejected.length) {
    lines.push("", "## 被拒绝或缺少的结论", "")
    for (const item of result.rejected) lines.push("- " + plain(item.ruleId + "：" + item.reason + "；" + item.detail))
  }
  if (result.notLocated.length) {
    lines.push("", "## 未定位的检查项", "")
    for (const item of result.notLocated) {
      lines.push("- " + plain(item.ruleId + "：" + (item.reason === "no-match" ? "未执行" : "仅有目录，待核实") + "；" + item.detail))
    }
    lines.push("", "以上检查项不计为已通过，需补充材料或人工确认。")
  }
  lines.push("")
  return lines.join("\n")
}
