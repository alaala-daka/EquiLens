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
