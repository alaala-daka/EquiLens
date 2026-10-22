import { createHash } from "node:crypto"
import { fork } from "node:child_process"
import { access, readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { unzipSync } from "fflate"
import { XMLParser } from "fast-xml-parser"
import { validateDocxBytes, MAX_FILE_BYTES } from "../../../src/lib/documents/docx"
import { ReviewError } from "./errors"
import type { Paragraph } from "./types"

export type ParsedDocument = { paragraphs: Paragraph[]; complete: boolean; warnings: string[]; sha256: string }
type Node = Record<string, unknown>
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true,
  parseTagValue: false, trimValues: false,
})
const children = (value: unknown): Node[] => Array.isArray(value) ? value as Node[] : []

// 只读取文本节点；段落样式、属性和域代码不会混入合同文字。
function runText(nodes: Node[]): string {
  return nodes.map(node => Object.entries(node).map(([key, value]) => {
    if (key === "t") return children(value).map(item => String(item["#text"] ?? "")).join("")
    if (key === "tab") return "\t"
    if (key === "br" || key === "cr") return "\n"
    if (key.startsWith("@") || key.endsWith("Pr") || key === ":@") return ""
    return Array.isArray(value) ? runText(children(value)) : ""
  }).join("")).join("")
}

/** 仅供隔离子进程及合成测试使用；上传文件通过 parseDocument 调用。 */
export function parseDocxBytes(bytes: Uint8Array): Paragraph[] {
  // 复用主应用的 ZIP/CRC/类型/外链/活动内容/不支持结构校验。
  validateDocxBytes(bytes)
  const files = unzipSync(bytes, { filter: file => file.name === "word/document.xml" })
  const nodes = children(parser.parse(new TextDecoder("utf8", { fatal: true }).decode(files["word/document.xml"])))
  const unsupported = new Set(["AlternateContent", "fldSimple", "sym", "subDoc", "contentPart", "oMath", "oMathPara", "vanish", "webHidden"])
  const checkStructures = (items: Node[]) => {
    for (const node of items) for (const [key, value] of Object.entries(node)) {
      if (unsupported.has(key)) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
      if (Array.isArray(value)) checkStructures(children(value))
    }
  }
  checkStructures(nodes)
  const document = nodes.find(node => "document" in node)
  const body = children(document?.document).find(node => "body" in node)
  if (!body) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
  const paragraphs: Paragraph[] = []
  let tableIndex = 0
  const push = (value: unknown, table?: Paragraph["table"]) => {
    const text = runText(children(value)).trim()
    if (text) paragraphs.push({ index: paragraphs.length, text, inTable: Boolean(table), ...(table ? { table } : {}) })
  }
  // preserveOrder 保留 p/tbl 交错顺序及各个 run 的顺序。
  for (const node of children(body.body)) {
    if (Object.keys(node).some(key => !["p", "tbl", "sectPr", "bookmarkStart", "bookmarkEnd", "proofErr", "permStart", "permEnd", ":@", "#text"].includes(key))) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
    if ("p" in node) push(node.p)
    if ("tbl" in node) {
      tableIndex++
      let row = 0
      for (const rowNode of children(node.tbl)) {
        if (!("tr" in rowNode)) continue
        row++
        let column = 0
        for (const cell of children(rowNode.tr)) {
          if (!("tc" in cell)) continue
          column++
          for (const part of children(cell.tc)) {
            if ("tbl" in part) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
            if ("p" in part) push(part.p, { index: tableIndex, row, column })
          }
        }
      }
    }
  }
  if (paragraphs.reduce((sum, item) => sum + item.text.length, 0) > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
  return paragraphs
}

export function paragraphsFromString(text: string): Paragraph[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .map((line, index) => ({ index, text: line, inTable: false }))
}
export function isDocxPath(path: string): boolean { return path.toLowerCase().endsWith(".docx") }

async function readDocxInChild(bytes: Buffer): Promise<Paragraph[]> {
  const worker = resolve(process.cwd(), "scripts/generated/contract-reader.mjs")
  try { await access(worker) } catch { throw new ReviewError("REVIEW_PARSER_UNAVAILABLE") }
  return new Promise((accept, reject) => {
    const child = fork(/* turbopackIgnore: true */ worker, [], {
      execArgv: ["--max-old-space-size=512"], windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { NODE_ENV: "production" },
    })
    let settled = false
    const finish = (error?: Error, paragraphs?: Paragraph[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else accept(paragraphs ?? [])
    }
    const timer = setTimeout(() => finish(new ReviewError("REVIEW_DOCUMENT_TIMEOUT")), 60000)
    child.once("error", () => finish(new ReviewError("REVIEW_PARSER_UNAVAILABLE")))
    child.once("exit", () => finish(new ReviewError("REVIEW_DOCUMENT_INVALID")))
    child.once("message", message => {
      const value = message as { valid?: boolean; paragraphs?: Paragraph[] }
      if (value?.valid === true && Array.isArray(value.paragraphs)) finish(undefined, value.paragraphs)
      else finish(new ReviewError("REVIEW_DOCUMENT_INVALID"))
    })
    child.send({ bytes: bytes.toString("base64") }, error => { if (error) finish(new ReviewError("REVIEW_DOCUMENT_INVALID")) })
  })
}

export async function parseDocument(path: string): Promise<ParsedDocument> {
  if (!isDocxPath(path) && !path.toLowerCase().endsWith(".txt")) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
  let bytes: Buffer
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
    if (info.size > MAX_FILE_BYTES) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
    bytes = await readFile(path)
    if (bytes.length > MAX_FILE_BYTES) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
  } catch (failure) {
    if (failure instanceof ReviewError) throw failure
    throw new ReviewError("REVIEW_DOCUMENT_INVALID")
  }
  let paragraphs: Paragraph[]
  if (isDocxPath(path)) paragraphs = await readDocxInChild(bytes)
  else {
    let text: string
    try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes) }
    catch { throw new ReviewError("REVIEW_DOCUMENT_INVALID") }
    if (text.includes("\0")) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
    if (text.length > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
    paragraphs = paragraphsFromString(text)
  }
  if (!paragraphs.length) throw new ReviewError("REVIEW_INPUT_INVALID")
  return { paragraphs, complete: true, warnings: [], sha256: createHash("sha256").update(bytes).digest("hex") }
}

export async function extractParagraphs(path: string): Promise<Paragraph[]> {
  return (await parseDocument(path)).paragraphs
}
