import type { Paragraph, ReviewContext, RuleEntry, TriggeredRule } from "./types"

// 归一化：去掉空白与常见标点差异，使关键词匹配不受排版影响。
export function normalize(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, "")
    .replace(/[（）()【】\[\]《》""''"":：;；,，.。!！?？、]/g, "")
    .toLowerCase()
}

// 否定表述也是待检查的合同内容，不能在召回阶段排除。
export function matchParagraph(rule: RuleEntry, paragraph: Paragraph): boolean {
  const flat = normalize(paragraph.text)
  return rule.trigger.keywords.some(keyword => {
    const needle = normalize(keyword)
    if (!needle || !flat.includes(needle)) return false
    return true
  })
}

export function applicability(rule: RuleEntry, context: ReviewContext): "applicable" | "unknown" | "excluded" {
  let unknown = false
  for (const field of ["role", "projectType", "region"] as const) {
    const required = rule.appliesTo[field]
    if (!required) continue
    const actual = context[field]
    if (!actual) unknown = true
    else if (normalize(required) !== normalize(actual)) return "excluded"
  }
  return unknown ? "unknown" : "applicable"
}

export function isApplicable(rule: RuleEntry, context: ReviewContext = {}): boolean {
  return applicability(rule, context) === "applicable"
}

// 场景必检规则无关键词也进入计划；关键词仅用于辅助定位。
export function matchRules(rules: RuleEntry[], paragraphs: Paragraph[], context: ReviewContext = {}): TriggeredRule[] {
  const triggered: TriggeredRule[] = []
  for (const rule of rules) {
    if (!isApplicable(rule, context)) continue
    const excerpts: TriggeredRule["excerpts"] = []
    for (const paragraph of paragraphs) {
      if (matchParagraph(rule, paragraph)) {
        excerpts.push({ ruleId: rule.ruleId, paragraphIndex: paragraph.index, text: paragraph.text })
      }
    }
    if (rule.mandatory !== false || excerpts.length) triggered.push({ rule, excerpts })
  }
  return triggered
}
