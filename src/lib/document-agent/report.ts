import { documentTaskLabels, type DocumentAnalysis } from "./types"

export function formatFen(value: string) {
  const amount = BigInt(value), absolute = amount < BigInt(0) ? -amount : amount
  return `${amount < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${(absolute % BigInt(100)).toString().padStart(2, "0")} 元`
}
const text = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}()<>!#|]/g, "\\$&")
export function documentAnalysisMarkdown(analysis: DocumentAnalysis, title: string, revisionId?: string, snapshotId?: string) {
  const data = analysis.extraction, label = documentTaskLabels[analysis.task]
  const accepted = (id: string) => !analysis.rejected.some(item => item.id === id) && analysis.audit.checks.some(item => item.id === id && item.accepted)
  const lines = [`# ${label}`, "", text(title), "", `核对截止日：${analysis.cutoff} · AI 整理，待人工复核`, ""]
  if (!data) { lines.push("本次尚未形成有效整理结果。", ""); return lines.join("\n") }
  if (accepted("overview")) lines.push(text(data.overview), "")
  if (analysis.letter) lines.push("## 催款函草稿", "", text(analysis.letter.title), "", ...analysis.letter.paragraphs.flatMap(line => [text(line), ""]))
  if (analysis.calculation) lines.push("## 款项测算", "", `已到期净应付：${formatFen(analysis.calculation.netDueFen)}`, `已列明付款：${formatFen(analysis.calculation.paidFen)}`,
    `有条件测算余额：${formatFen(analysis.calculation.unpaidFen)}`, text(analysis.calculation.formula), "")
  if (data.amounts.length) {
    lines.push("## 材料记载金额", "", "| 项目 | 性质 | 金额 | 机器核对 |", "| --- | --- | --- | --- |")
    data.amounts.forEach((item, index) => { if (!analysis.rejected.some(row => row.id === "amount:" + index)) {
      lines.push(`| ${text(item.label)} | ${item.kind} | ${text(item.amountYuan)} 元 | ${accepted("amount:" + index) ? "待人工复核" : "需核对"} |`, `| 原文 | 第${item.source.paragraphIndex + 1}段 | ${text(item.source.quote)} | |`)
    } }); lines.push("")
  }
  if (data.terms.length) lines.push("## 付款约定", "", ...data.terms.flatMap((item, index) => analysis.rejected.some(row => row.id === "term:" + index) ? [] : [`- ${text(item.title)}：${text(item.detail)}`, ...item.sources.map(source => `  - 第${source.paragraphIndex + 1}段：${text(source.quote)}`)]), "")
  if (data.events.length) {
    lines.push("## 证据时间线", "")
    data.events.map((item, index) => ({ item, index })).sort((a, b) => (a.item.date ?? "9999").localeCompare(b.item.date ?? "9999")).forEach(({ item, index }) => {
      if (analysis.rejected.some(row => row.id === "event:" + index)) return
      lines.push(`- ${item.date ?? "日期未明"} · ${text(item.title)} · ${item.nature} / ${item.support}`, `  ${text(item.detail)}`,
        ...item.sources.map(source => `  - 来源第${source.paragraphIndex + 1}段：${text(source.quote)}`), ...item.conflicts.map(source => `  - 冲突来源第${source.paragraphIndex + 1}段：${text(source.quote)}`))
    }); lines.push("")
  }
  if (data.disputes.length) lines.push("## 争点", "", ...data.disputes.flatMap((item, index) => analysis.rejected.some(row => row.id === "dispute:" + index) ? [] : [`- ${text(item.title)}：${text(item.detail)}`]), "")
  const gaps = [...new Set([...data.gaps, ...analysis.audit.gaps, ...analysis.calculationNotes])]
  if (gaps.length) lines.push("## 需要补充或核对", "", ...gaps.map(gap => "- " + text(gap)), "")
  const notes = [...new Set([...(data.notes ?? []), ...(analysis.audit.notes ?? [])])]
  if (notes.length) lines.push("## 范围提示", "", ...notes.map(note => "- " + text(note)), "")
  if (!analysis.audit.complete) lines.push("独立核对尚未完成，已有整理结果保留。", "")
  const rejected = [...analysis.rejected.map(item => item.reason), ...analysis.audit.checks.filter(item => !item.accepted).map(item => item.reason)]
  if (rejected.length) lines.push("## 未采用或存疑内容", "", ...[...new Set(rejected)].map(reason => "- " + text(reason)), "")
  lines.push("## 版本", "", `文档版本：${text(revisionId ?? "")}`, `解析快照：${text(snapshotId ?? "")}`, `技能：${analysis.skill.id} ${analysis.skill.version} / ${analysis.skill.sha256}`, "")
  return lines.join("\n")
}
