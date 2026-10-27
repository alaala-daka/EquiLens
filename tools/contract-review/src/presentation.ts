import { CHECK_CATEGORIES, type Finding, type ReviewResult } from "./types"

const severityOrder: Record<Finding["severity"], number> = { 重大关注: 0, 一般关注: 1, 提示: 2 }

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.paragraphIndex - b.paragraphIndex)
}

/** 仅生成带省略标记的展示预览；不改写或保存到原始结论。 */
export function compactText(value: string, limit: number): string {
  const characters = Array.from(value.replace(/\s+/g, " ").trim())
  return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("") + "…"
}

export function groupIssues(findings: Finding[]) {
  return CHECK_CATEGORIES.map(category => ({
    category,
    findings: sortFindings(findings.filter(item => item.category === category &&
      (item.kind === "发现问题" || item.kind === "缺失条款"))),
  })).filter(group => group.findings.length > 0)
}

export function isCompleteNoRisk(result: ReviewResult): boolean {
  if (result.collaboration && (result.collaboration.audit?.status !== "completed" || result.collaboration.audit.checks.some(item => item.outcome === "需人工核对"))) return false
  return result.status === "success" && result.input.complete && result.errors.length === 0 &&
    result.notLocated.length === 0 && result.findings.length > 0 &&
    result.findings.every(item => item.kind === "未发现问题" && item.pending.length === 0) &&
    CHECK_CATEGORIES.every(category => result.coverage.some(item => item.category === category && item.status === "未发现问题"))
}

export const CATEGORY_LABELS = {
  付款条件与时间: "付款", 计量结算: "结算", 工期: "工期", 变更签证: "变更", 违约责任: "责任分担", 争议约定: "争议解决",
} as const

/** 只识别整段已知共性声明；含具体事实、否定或未知措辞的段落原样保留。 */
function isDebugNotice(text: string): boolean {
  const clauses = text.replace(/^调试声明[：:]\s*/, "").replace(/[。\s]+$/u, "").split(/[，,]/).map(item => item.trim())
  return clauses.length > 0 && clauses.every(clause =>
    /^(?:本结论)?(?:所引)?(?:依据来源|依据|来源|资料)(?:状态为待核对|状态待核对|为审查摘要示例且状态(?:为)?待核对|尚未核对)$/.test(clause) ||
    /^(?:仅供联调|不构成正式法律意见|不构成正式法律结论|不能作为正式法律结论|须回查示范文本(?:官方)?原文)$/.test(clause))
}

function isUnfinishedFinding(item: Finding): boolean {
  return Boolean(item.placeholder) || (item.kind === "待核实" &&
    item.risk === "该必检项尚未取得有效结论，需要补读或重新审查。")
}

/** 只生成展示投影；不更改 findings、复核状态、已保存 JSON 或完整无风险闸门。 */
export function getReportView(result: ReviewResult) {
  const groups = groupIssues(result.findings)
  const issueCount = groups.reduce((count, group) => count + group.findings.length, 0)
  const confirmations: { text: string; ruleIds: string[]; categories: Finding["category"][] }[] = []
  const unfinished: { ruleId: string; category?: Finding["category"]; detail: string }[] = []
  const addUnfinished = (ruleId: string, detail: string, category?: Finding["category"]) => {
    const existing = unfinished.find(item => item.ruleId === ruleId)
    if (!existing) unfinished.push({ ruleId, detail, category })
    else if (detail && !existing.detail.includes(detail)) existing.detail += "；" + detail
  }
  for (const item of result.findings) {
    if (isUnfinishedFinding(item)) { addUnfinished(item.ruleId, item.pending.join("；") || item.risk, item.category); continue }
    const notes = item.pending.length ? item.pending : item.kind === "待核实" ? [item.risk] : []
    const texts = notes.flatMap(note => note.split(/[；;\n]/)).map(note => note.trim())
      .filter(note => note && !(result.mode === "debug" && isDebugNotice(note)))
    if (!texts.length && item.kind === "待核实" && item.risk.trim() && !(result.mode === "debug" && isDebugNotice(item.risk))) texts.push(item.risk)
    for (const text of texts) {
      const existing = confirmations.find(note => note.text === text)
      if (!existing) confirmations.push({ text, ruleIds: [item.ruleId], categories: [item.category] })
      else {
        if (!existing.ruleIds.includes(item.ruleId)) existing.ruleIds.push(item.ruleId)
        if (!existing.categories.includes(item.category)) existing.categories.push(item.category)
      }
    }
  }
  for (const item of result.notLocated) addUnfinished(item.ruleId, item.detail)
  for (const item of result.rejected) {
    if (!result.findings.some(finding => finding.ruleId === item.ruleId && !isUnfinishedFinding(finding)))
      addUnfinished(item.ruleId, item.reason + "：" + item.detail)
  }
  const unfinishedGroups: { label: string; count: number }[] = []
  for (const item of unfinished) {
    const category = item.category ?? result.findings.find(finding => finding.ruleId === item.ruleId)?.category
    const label = category ? CATEGORY_LABELS[category] : "其他检查"
    const existing = unfinishedGroups.find(group => group.label === label)
    if (existing) existing.count++
    else unfinishedGroups.push({ label, count: 1 })
  }
  const audit = result.collaboration?.audit
  const auditFlagCount = audit?.checks.filter(item => item.outcome === "需人工核对").length ?? 0
  const auditIncomplete = Boolean(result.collaboration && audit?.status !== "completed")
  const scopeNotes: string[] = []
  if (!result.input.complete) scopeNotes.push("材料解析不完整，当前结果未覆盖全部内容。")
  if (result.agent && result.agent.readParagraphIndexes.length < result.paragraphs.length)
    scopeNotes.push("部分正文尚未检查，当前结果未覆盖全部内容。")
  const uncovered = result.coverage.filter(item => item.status === "未覆盖")
  if (uncovered.length) scopeNotes.push(uncovered.map(item => CATEGORY_LABELS[item.category]).join("、") + "尚未覆盖。")
  const incomplete = result.status !== "success" || unfinished.length > 0 || scopeNotes.length > 0 || result.errors.length > 0 || auditIncomplete
  const summary = issueCount > 0
    ? (incomplete ? "初步结果：" : "") + `发现 ${issueCount} 项问题，涉及 ${groups.length} 类事项。`
    : isCompleteNoRisk(result) ? "本次检查范围内未发现问题，仍需人工复核。" : "尚不能确认无风险，请查看待确认事项与检查进度。"
  const auditNotice = auditIncomplete ? "AI 复查尚未完成，当前结论仍需进一步核对。"
    : auditFlagCount ? `AI 复查提出 ${auditFlagCount} 项需人工核对的意见。` : null
  return { groups, issueCount, confirmations, unfinished, unfinishedGroups, scopeNotes, incomplete, summary, auditNotice, auditFlagCount }
}
