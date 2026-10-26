import type { Paragraph } from "./types"

/** 窄范围检查，不推断法律适用，也不尝试解析任意替代方案。调用方须已完整读取正文。 */
export function adviceConflict(suggestion: string, paragraphs: Paragraph[]): string | null {
  const clauses = paragraphs.flatMap(paragraph => {
    const match = paragraph.text.match(/^\s*(?:第\s*)?(\d+(?:\.\d+)+)(?![\d.])\s*(?:条)?/u)
    return match ? [{ number: match[1], text: paragraph.text }] : []
  })
  const hasMode = (text: string, mode: string) => mode === "诉讼" ? /诉讼|起诉|人民法院/u.test(text) : /仲裁/u.test(text)
  // 仅匹配整条删除后紧接保留方式；删除“条款中的部分文字”、另行新增及分开的互斥方案不在此列。
  const actions = suggestion.matchAll(/删除\s*(?:第\s*)?(\d+(?:\.\d+)+)(?![\d.])\s*(?:条)?\s*[，,、]\s*(?:并\s*)?保留\s*(诉讼|仲裁)/gu)
  for (const action of actions) {
    const [, number, mode] = action
    const matches = clauses.filter(clause => clause.number === number)
    if (matches.length !== 1) continue
    const clause = matches[0]
    const otherMode = mode === "诉讼" ? "仲裁" : "诉讼"
    if (!hasMode(clause.text, mode) || hasMode(clause.text, otherMode)) continue
    // 其余正文出现该方式时，无法确定是否已有另一约定，留给人工核对。
    if (paragraphs.some(paragraph => paragraph.text !== clause.text && hasMode(paragraph.text, mode))) continue
    return `建议删除第 ${number} 条，却同时要求保留该条唯一约定的${mode}方式；请核对条款编号与保留方式。`
  }
  return null
}
