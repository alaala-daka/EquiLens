import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate"
import { XMLParser, XMLBuilder } from "fast-xml-parser"
import { parseDocxBytes } from "./document"
import { canExportRevision, revisionQuestions, validateRevision, revisedParagraphs, type RevisionState, type RevisionAudit } from "./revision"
import type { ReviewResult } from "./types"
import { draftHash, revisionHash } from "./agent/revision"

export const REVISION_RENDER_VERSION = "contract-revision-docx-v1"
type Node = Record<string, unknown>
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value as Node[] : []
const local = (key: string) => key.split(":").at(-1)!
const text = (items: Node[]): string => items.map(node => Object.entries(node).map(([key, value]) => {
  const name = local(key)
  if (name === "t") return nodes(value).map(item => String(item["#text"] ?? "")).join("")
  if (name === "tab") return "\t"
  if (name === "br" || name === "cr") return "\n"
  return key === ":@" || name.endsWith("Pr") ? "" : Array.isArray(value) ? text(nodes(value)) : ""
}).join("")).join("")

/** 仅在资源受限子进程及合成测试中执行，不修改传入字节或原文档。 */
export function buildRevisionDocx(bytes: Uint8Array, primary: ReviewResult, draft: RevisionState, audit: RevisionAudit): Uint8Array {
  if (!canExportRevision(draft, audit) || draft.sha256 !== draftHash(draft) || draft.primarySha256 !== revisionHash(primary) ||
    !validateRevision(primary, draft.edits, draft.decisions, draft.decisions.map(item => item.ruleId)) || JSON.stringify(draft.paragraphs) !== JSON.stringify(revisedParagraphs(primary.paragraphs, draft.edits))) throw new Error("修订稿与机器核对记录不匹配。")
  const parsed = parseDocxBytes(bytes)
  if (JSON.stringify(parsed) !== JSON.stringify(primary.paragraphs)) throw new Error("源 Word 与固定解析快照不匹配。")
  const files = unzipSync(bytes)
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false })
  const document = nodes(parser.parse(strFromU8(files["word/document.xml"])))
  const root = document.find(node => Object.keys(node).some(key => local(key) === "document"))
  const rootKey = root && Object.keys(root).find(key => local(key) === "document")
  if (!root || !rootKey) throw new Error("Word 正文无效。")
  const prefix = rootKey.includes(":") ? rootKey.split(":")[0] + ":" : ""
  const body = nodes(root[rootKey]).find(node => Object.keys(node).some(key => local(key) === "body"))
  const bodyKey = body && Object.keys(body).find(key => local(key) === "body")
  if (!body || !bodyKey) throw new Error("Word 正文无效。")
  const content = nodes(body[bodyKey])
  const paragraph = (value: string): Node => ({ [prefix + "p"]: [{ [prefix + "r"]: [{ [prefix + "t"]: [{ "#text": value }], ":@": { "@_xml:space": "preserve" } }] }] })
  const targets: { parent: Node[]; node: Node; key: string }[] = []
  const collect = (items: Node[]) => { for (const node of items) for (const [key, value] of Object.entries(node)) {
    if (local(key) === "p") { if (text(nodes(value)).trim()) targets.push({ parent: items, node, key }) }
    else if (key !== ":@" && Array.isArray(value)) collect(nodes(value))
  } }
  collect(content)
  if (targets.length !== parsed.length || targets.some((item, index) => text(nodes(item.node[item.key])).trim() !== parsed[index].text)) throw new Error("Word 段落映射无效。")
  for (const edit of draft.edits) {
    const target = targets[edit.paragraphIndex]
    if (edit.operation === "replace") {
      if (nodes(target.node[target.key]).some(node => Object.keys(node).some(key => key !== ":@" && !["pPr", "r", "#text"].includes(local(key)))))
        throw new Error("待修改段落含书签、链接或其他未验证的内联结构，未生成修订文件。")
      const properties = nodes(target.node[target.key]).filter(node => Object.keys(node).some(key => local(key) === "pPr"))
      target.node[target.key] = [...properties, ...nodes(paragraph(edit.after)[prefix + "p"])]
    } else {
      if (target.parent !== content) throw new Error("仅支持在正文段落后插入。")
      target.parent.splice(target.parent.indexOf(target.node) + 1, 0, paragraph(edit.after))
    }
  }
  const marker = "合同修订建议稿（AI 生成，待人工审核）"
  content.unshift(paragraph(marker))
  const questions = revisionQuestions(draft, audit)
  const ending = [primary.mode === "debug" ? "本建议稿依据尚未核对，仅供联调，需专业人员审核。" : "本建议稿需人工审核，机器核对不代表双方同意。",
    ...(questions.length ? ["尚待确认事项：", ...questions] : [])]
  const section = content.findIndex(node => Object.keys(node).some(key => local(key) === "sectPr"))
  content.splice(section < 0 ? content.length : section, 0, ...ending.map(paragraph))
  files["word/document.xml"] = strToU8(new XMLBuilder({ preserveOrder: true, ignoreAttributes: false }).build(document))
  const output = zipSync(files, { level: 6 })
  const check = parseDocxBytes(output)
  const expected = [marker, ...draft.paragraphs.map(item => item.text), ...ending]
  if (check.length !== expected.length || check.some((item, index) => item.text !== expected[index])) throw new Error("生成 Word 正文与保存稿不一致。")
  const actualBody = check.slice(1, 1 + draft.paragraphs.length)
  if (actualBody.some((item, index) => JSON.stringify(item.table) !== JSON.stringify(draft.paragraphs[index].table))) throw new Error("生成 Word 的表格位置不一致。")
  return output
}
