import type { Finding, ReviewResult } from "./types"
import { CATEGORY_LABELS, compactText, getReportView, sortFindings } from "./presentation"

const plain = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}<>|]/g, "\\$&")
const details = (title: string, body: string[]) => ["<details>", "<summary>" + plain(title) + "</summary>", "", ...body, "", "</details>", ""]

export { sortFindings } from "./presentation"
export function toJson(result: ReviewResult): string { return JSON.stringify(result, null, 2) }

function findingDetails(item: Finding, result: ReviewResult): string[] {
  const lines = ["- 检查项：" + plain(item.ruleId + " · " + item.category + " · " + item.severity), "- 具体问题：" + plain(item.risk)]
  if (item.kind === "缺失条款") lines.push("- 位置：所提供的完整检查范围，未找到必要约定", "- 已检查：" + (item.checkedParagraphIndexes?.length ?? 0) + " 段正文")
  else if (item.paragraphIndex >= 0) lines.push("- 位置：第 " + (item.paragraphIndex + 1) + " 段")
  if (item.quote) lines.push("- 原文：" + plain(item.quote))
  for (const citation of item.citations ?? []) {
    if (citation.paragraphIndex === item.paragraphIndex && citation.quote === item.quote) continue
    lines.push("- 补充引文（第 " + (citation.paragraphIndex + 1) + " 段）：" + plain(citation.quote))
  }
  const references = item.sourceReferences?.map(source => source.sourceId + " " + source.type + "：" + source.name +
    (source.article ? " " + source.article : "") + (source.version ? " / " + source.version : "") + " · " + source.status +
    (source.officialUrl ? " · " + source.officialUrl : ""))
  lines.push("- 依据：" + plain(references?.join("；") || item.basis.join("、")))
  if (item.impact) lines.push("- 为什么需要关注：" + plain(item.impact))
  lines.push("- 建议如何修改：" + plain(item.suggestion), "- 复核状态：" + item.reviewStatus)
  if (result.collaboration) {
    const check = result.collaboration.audit?.checks.find(check => check.ruleId === item.ruleId)
    lines.push("- AI 复查意见：" + (check ? plain(check.outcome + " · " + check.note) : "此项尚未完成 AI 复查。"))
    if (check?.quote) lines.push("- 复查引文（第 " + (check.paragraphIndex + 1) + " 段）：" + plain(check.quote))
  }
  return lines
}

function sceneDetails(result: ReviewResult): string[] {
  const selection = result.sceneSelection
  if (!selection) return []
  return ["- 理由：" + plain(selection.reason), ...selection.missingInfo.map(item => "- 待补信息：" + plain(item)),
    ...selection.evidence.map(item => "- 原文（第 " + (item.paragraphIndex + 1) + " 段）：" + plain(item.quote))]
}

function auditDetails(result: ReviewResult): string[] {
  if (!result.collaboration) return []
  const audit = result.collaboration.audit
  const lines = ["### AI 复查", "", "- 状态：" + (audit?.status === "completed" ? "已完成" : "未完成"),
    "- 已核对：" + (audit?.checks.length ?? 0) + " / " + result.findings.length,
    "- 机器意见不能替代人工审核，主审原结果保留。", ""]
  if (audit?.unreviewedRuleIds.length) lines.push("- 尚未复查：" + plain(audit.unreviewedRuleIds.join("、")), "")
  for (const check of audit?.checks ?? []) {
    lines.push("- " + plain(check.ruleId + " · " + check.outcome + "：" + check.note))
    if (check.quote) lines.push("  原文（第 " + (check.paragraphIndex + 1) + " 段）：" + plain(check.quote))
    if (check.basis.length) lines.push("  依据：" + plain(check.basis.join("、")))
  }
  for (const rejected of audit?.rejected ?? []) lines.push("- 未采用复查意见：" + plain(rejected.ruleId + "：" + rejected.reason))
  for (const error of audit?.errors ?? []) lines.push("- 复查错误：" + plain(error.code + "：" + error.message))
  return lines
}

export function toMarkdown(result: ReviewResult): string {
  const selection = result.sceneSelection
  if (result.sceneCandidates && selection?.status !== "matched") return [
    "# 合同场景识别：" + plain(result.documentTitle), "",
    selection ? selection.status === "unsupported" ? "场景不支持" : "场景待确认" : "场景识别未完成。", "",
    ...sceneDetails(result), "", ...result.errors.map(item => "- " + plain(item.message)), "",
    "未执行合同审查。请核对合同类型或补充材料后重新审查。", "",
    ...details("报告记录", ["- 结果 ID：" + result.reviewId, "- 输入文字 SHA-256：" + result.input.textSha256,
      "- 执行状态：" + result.status, "- 模型调用预算占用：" + result.callsUsed,
      ...result.errors.map(item => "- " + plain(item.code + "：" + item.message))]),
  ].join("\n")
  const view = getReportView(result)
  const label = result.sceneCandidates?.find(item => item.id === selection?.sceneId)?.label ?? result.input.context.projectType ?? "合同审查"
  const lines = ["# 合同审查报告：" + plain(result.documentTitle), "",
    plain(label + " · 审查立场：" + (result.input.context.role ?? "未确认")), "", "**" + view.summary + "**", ""]
  if (view.unfinished.length) lines.push("另有 " + view.unfinished.length + " 项检查未形成有效结论。", "")
  if (view.incomplete && !view.unfinished.length && !view.auditNotice) lines.push("审查尚未完成，请查看检查进度。", "")
  if (view.auditNotice) lines.push(view.auditNotice, "")
  for (const note of view.scopeNotes) lines.push(plain(note), "")
  if (view.groups.length) lines.push("## 优先处理的问题", "", "以下展示各类优先项，展开可查看其余问题。", "")
  for (const [index, group] of view.groups.entries()) {
    const [first, ...rest] = group.findings
    lines.push("### " + (index + 1) + ". " + CATEGORY_LABELS[group.category], "",
      plain(compactText(first.risk, 80)), "", "**修改方向：** " + plain(compactText(first.suggestion, 120)), "")
    if (result.collaboration?.audit?.checks.some(check => check.ruleId === first.ruleId && check.outcome === "需人工核对"))
      lines.push("AI 复查对此项有疑问，请展开核对。", "")
    lines.push(...details("展开原文、解释与依据", findingDetails(first, result)))
    if (rest.length) lines.push(...details("查看本类其余 " + rest.length + " 项问题", rest.flatMap(item =>
      ["#### " + plain(item.ruleId), "", ...findingDetails(item, result), ""])))
  }
  if (view.confirmations.length) {
    lines.push("## 需要进一步确认", "", ...view.confirmations.map(item => "- " + plain(item.text)), "")
    lines.push(...details("相关条款与核对说明", result.findings.filter(item => view.confirmations.some(note => note.ruleIds.includes(item.ruleId)))
      .flatMap(item => ["### " + plain(item.ruleId), "", ...findingDetails(item, result), ""])))
  }
  lines.push("## " + (view.incomplete ? "尚未完成的检查" : "检查记录"), "")
  for (const item of view.unfinishedGroups) lines.push("- " + item.label + "：还有 " + item.count + " 项检查未形成有效结论。")
  if (view.auditNotice) lines.push("- " + view.auditNotice)
  for (const error of result.errors.filter(item => !["REVIEW_AUDIT_INCOMPLETE", "REVIEW_PRIMARY_INCOMPLETE"].includes(item.code)))
    lines.push("- " + plain(error.message))
  lines.push("")
  const progress = ["- 结果 ID：" + result.reviewId, "- 执行状态：" + result.status, "- 时间：" + result.createdAt,
    "- 模式：" + (result.mode === "debug" ? "开发调试，依据未核对" : "已发布规则"),
    "- 规则包版本：" + plain(result.packVersion), "- 保存版本：" + (result.input.documentVersionId ?? "未标注"),
    "- 解析快照：" + (result.input.parseSnapshotId ?? "未标注"), "- 输入文字 SHA-256：" + result.input.textSha256,
    "- 输入完整：" + (result.input.complete ? "是（调用方声明的解析范围）" : "否"),
    "- 模型：" + plain(result.model), "- 模型调用预算占用：" + result.callsUsed, ""]
  if (result.usage) progress.push("- Token 用量：" + result.usage.totalTokens, "")
  if (result.agent) progress.push("- 技能：" + plain(result.agent.skill.id + " / " + result.agent.skill.version),
    "- 已读正文：" + result.agent.readParagraphIndexes.length + " / " + result.paragraphs.length + " 段", "")
  if (selection) progress.push(...details("场景识别依据", sceneDetails(result)))
  progress.push(...auditDetails(result), "", "| 检查类别 | 状态 | 说明 |", "| --- | --- | --- |")
  for (const item of result.coverage) progress.push("| " + item.category + " | " + item.status + " | " + plain(item.note) + " |")
  progress.push("", ...view.unfinished.map(item => "- 未完成检查：" + plain(item.ruleId + "：" + item.detail)),
    ...result.errors.map(item => "- " + plain(item.code + "：" + item.message + "（" + item.ruleIds.join("、") + "）")),
    ...result.warnings.map(item => "- " + plain(item)), "")
  if (result.rejected.length) progress.push(...details("未采用的回答", result.rejected.map(item => "- " + plain(item.ruleId + "：" + item.reason + "；" + item.detail))))
  if (result.notLocated.length) progress.push(...details("未定位的检查项", [
    ...result.notLocated.map(item => "- " + plain(item.ruleId + "：" + (item.reason === "no-match" ? "未执行" : "仅有目录，待核实") + "；" + item.detail)),
    "", "以上检查项不计为已通过，需补充材料或人工确认。",
  ]))
  if (result.findings.some(item => item.pending.length)) progress.push(...details("原始待核实记录", result.findings.filter(item => item.pending.length)
    .map(item => "- " + plain(item.ruleId + "：" + item.pending.join("；")))))
  lines.push(...details("展开检查进度与停止原因", progress))
  const clear = sortFindings(result.findings.filter(item => item.kind === "未发现问题"))
  if (clear.length) lines.push(...details("查看无问题结论（" + clear.length + "）", clear.flatMap(item => ["### " + plain(item.ruleId), "", ...findingDetails(item, result), ""])))
  lines.push(result.mode === "debug" ? "*本报告依据尚未核对，仅供联调，需专业人员审核。*"
    : "*AI 辅助审查，结论需人工复核；引文真实不代表法律适用正确。*", "")
  return lines.join("\n")
}
