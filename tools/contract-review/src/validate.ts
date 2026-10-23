import {
  CHECK_CATEGORIES, SEVERITIES,
  type CategoryReport, type Finding, type Paragraph, type TriggeredRule,
  type RejectedFinding,
} from "./types"

export const REQUIRED_FIELDS = [
  "ruleId", "kind", "risk", "severity", "quote", "paragraphIndex", "basis", "impact", "suggestion", "pending",
] as const
export type RawFinding = Record<string, unknown>
export type ValidationOutcome = { findings: Finding[]; rejected: RejectedFinding[] }
const kinds = ["发现问题", "未发现问题", "缺失条款", "待核实"]
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string")
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

export function validateFindings(
  rawFindings: RawFinding[],
  triggered: TriggeredRule[],
  paragraphs: Paragraph[],
  usableSourceIds: Set<string>,
  complete = true,
): ValidationOutcome {
  const findings: Finding[] = []
  const rejected: RejectedFinding[] = []
  const counts = new Map<string, number>()
  for (const raw of rawFindings) if (typeof raw.ruleId === "string") counts.set(raw.ruleId, (counts.get(raw.ruleId) ?? 0) + 1)
  for (const raw of rawFindings) {
    const ruleId = typeof raw.ruleId === "string" ? raw.ruleId : ""
    const reject = (reason: string, detail: string) => { rejected.push({ ruleId, reason, detail }) }
    const entry = triggered.find(item => item.rule.ruleId === ruleId)
    if (!entry) { reject("规则不存在", "结论引用了本批未提供的规则。"); continue }
    if ((counts.get(ruleId) ?? 0) > 1) { reject("重复结论", "同一规则的所有重复回答均不采用，需重新核实。"); continue }
    if (REQUIRED_FIELDS.some(field => raw[field] === undefined || raw[field] === null)) {
      reject("字段缺失", "回答缺少必需字段。"); continue
    }
    if (!nonempty(raw.risk) || !nonempty(raw.suggestion) || typeof raw.impact !== "string" ||
        !strings(raw.pending) || !strings(raw.basis) || typeof raw.quote !== "string" ||
        !Number.isSafeInteger(raw.paragraphIndex) || typeof raw.kind !== "string" || !kinds.includes(raw.kind) ||
        !SEVERITIES.includes(raw.severity as Finding["severity"])) {
      reject("字段取值无效", "字段类型、枚举或段落编号不符合约定。"); continue
    }
    const kind = raw.kind as Finding["kind"]
    const quote = raw.quote.trim()
    const paragraphIndex = raw.paragraphIndex as number
    if (!complete && (kind === "未发现问题" || kind === "缺失条款")) {
      reject("范围不完整", "解析或已读正文范围不完整，不能确认没有问题或条款缺失。"); continue
    }
    if (kind === "缺失条款") {
      if (quote || paragraphIndex !== -1) { reject("引文校验失败", "缺失条款不得虚构引文，编号必须为 -1。"); continue }
    } else if (kind === "待核实" && !quote) {
      if (paragraphIndex !== -1 || !raw.pending.some(nonempty)) { reject("待核实信息缺失", "无引文时编号必须为 -1，并说明待核实事项。"); continue }
    } else {
      // 检查实际声明的段落，允许完整输入中的上下文引文，不擅自更改位置。
      const paragraph = paragraphs.find(item => item.index === paragraphIndex)
      if (!quote || !paragraph?.text.includes(quote)) { reject("引文校验失败", "引文未逐字出现在所声明的原文段落中。"); continue }
    }
    if (kind === "待核实" && !raw.pending.some(nonempty)) { reject("待核实信息缺失", "必须填写待核实事项。"); continue }
    const allowed = new Set(entry.rule.basis.map(item => item.sourceId))
    if (raw.basis.some(sourceId => !allowed.has(sourceId) || !usableSourceIds.has(sourceId)) ||
        (kind !== "待核实" && !raw.basis.length)) {
      reject("依据校验失败", "结论必须引用本规则允许且本次可用的来源；依据不足时应待核实。"); continue
    }
    const severity = raw.severity as Finding["severity"]
    findings.push({
      ruleId, category: entry.rule.category, kind, risk: raw.risk.trim(), severity,
      severityOrigin: severity === entry.rule.severity ? "规则预设" : "模型提出待定级",
      quote, paragraphIndex, basis: raw.basis,
      impact: raw.impact.trim(), suggestion: raw.suggestion.trim(),
      pending: raw.pending.filter(nonempty), reviewStatus: "待人工复核",
      ...(kind === "缺失条款" ? { checkedParagraphIndexes: paragraphs.map(item => item.index) } : {}),
    })
  }
  return { findings, rejected }
}

export function buildCoverage(findings: Finding[], triggered: TriggeredRule[]): CategoryReport[] {
  return CHECK_CATEGORIES.map(category => {
    const rules = triggered.filter(item => item.rule.category === category)
    const items = findings.filter(item => item.category === category)
    const ids = new Set(items.map(item => item.ruleId))
    const missing = rules.filter(item => !ids.has(item.rule.ruleId)).length
    const pending = items.filter(item => item.kind === "待核实").length
    let status: CategoryReport["status"]
    let note: string
    if (!rules.length) { status = "未覆盖"; note = "没有适用于本次范围的可用规则。" }
    else if (missing || pending) {
      status = "待核实"
      note = "应检查 " + rules.length + " 条；" + missing + " 条无有效结论，" + pending + " 条待核实；已发现的问题仍单独列出。"
    } else if (items.some(item => item.kind === "缺失条款")) { status = "缺失条款"; note = "完整检查范围内存在必要约定缺失。" }
    else if (items.some(item => item.kind === "发现问题")) { status = "发现问题"; note = "已完成本类规则检查并发现问题。" }
    else { status = "未发现问题"; note = "本类全部适用规则均有通过校验的无问题结论，仍须人工复核。" }
    return { category, status, findingIds: [...ids], note }
  })
}
