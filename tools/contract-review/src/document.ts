import { createHash } from "node:crypto"
import { fork } from "node:child_process"
import { access, readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { unzipSync } from "fflate"
import { XMLParser } from "fast-xml-parser"
import { validateDocxBytes, MAX_FILE_BYTES } from "../../../src/lib/documents/docx"
import { ReviewError } from "./errors"
import type { Paragraph, ParseCoverage } from "./types"

export type ParsedDocument = { paragraphs: Paragraph[]; complete: boolean; warnings: string[]; sha256: string }
type Node = Record<string, unknown>
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true,
  parseTagValue: false, trimValues: false,
})
const children = (value: unknown): Node[] => Array.isArray(value) ? value as Node[] : []

// Fallback/moveFrom 子树不入正文：Choice/Fallback 双份存储与移出内容不得双计，与 docx.ts 正文契约一致。
const skipTree = (key: string) => key === "Fallback" || key === "moveFrom" || key.startsWith("@") || key === ":@" || key === "#text"

// 只读取文本节点；段落样式、属性和域代码不会混入合同文字。
function runText(nodes: Node[]): string {
  return nodes.map(node => Object.entries(node).map(([key, value]) => {
    if (key === "t") return children(value).map(item => String(item["#text"] ?? "")).join("")
    if (key === "tab") return "\t"
    if (key === "br" || key === "cr") return "\n"
    if (key.startsWith("@") || key.endsWith("Pr") || key === ":@") return ""
    if (skipTree(key)) return ""
    return Array.isArray(value) ? runText(children(value)) : ""
  }).join("")).join("")
}

export function coverageComplete(coverage: ParseCoverage): boolean {
  return coverage.images === 0 && coverage.revisions === 0 && coverage.textboxes === 0 && coverage.complex === 0
}

const coverageLabels: [keyof ParseCoverage, string][] = [["images", "关键嵌图"], ["revisions", "修订标记"], ["textboxes", "文本框"], ["complex", "复杂结构"]]
function coverageWarnings(coverage: ParseCoverage): string[] {
  return coverageLabels.filter(([key]) => coverage[key] > 0).map(([, label]) => label)
}
const noCoverage = (): ParseCoverage => ({ images: 0, revisions: 0, textboxes: 0, complex: 0 })

/** 仅供隔离子进程及合成测试使用；上传文件通过 parseDocument 调用。 */
export function parseDocxBytes(bytes: Uint8Array): { paragraphs: Paragraph[]; coverage: ParseCoverage } {
  // 复用主应用的 ZIP/CRC/类型/外链/活动内容/不支持结构校验；覆盖按全量 structures 记录，页眉中的嵌图分析同样不可见。
  const { structures } = validateDocxBytes(bytes)
  const coverage: ParseCoverage = {
    images: structures.images,
    revisions: structures.revisions.insertions + structures.revisions.deletions + structures.revisions.moves + structures.revisions.formatChanges,
    textboxes: structures.textboxes,
    complex: 0,
  }
  const files = unzipSync(bytes, { filter: file => file.name === "word/document.xml" })
  const nodes = children(parser.parse(new TextDecoder("utf8", { fatal: true }).decode(files["word/document.xml"])))
  // 公式、符号、子文档、内容部件与隐藏文本无法按段落模型完整表达，每个出现计一次；
  // oMathPara 与其内嵌 oMath 是同一显示公式，只按 oMathPara 计一次。
  const complexKeys = new Set(["oMath", "oMathPara", "sym", "subDoc", "contentPart", "vanish", "webHidden"])
  const scanComplex = (items: Node[], inMathPara = false) => {
    for (const node of items) for (const [key, value] of Object.entries(node)) {
      if (skipTree(key)) continue
      if (complexKeys.has(key) && !(key === "oMath" && inMathPara)) coverage.complex++
      if (Array.isArray(value)) scanComplex(children(value), inMathPara || key === "oMathPara")
    }
  }
  scanComplex(nodes)
  const document = nodes.find(node => "document" in node)
  const body = children(document?.document).find(node => "body" in node)
  if (!body) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
  const paragraphs: Paragraph[] = []
  let tableIndex = 0
  const push = (value: unknown, table?: Paragraph["table"]) => {
    const text = runText(children(value)).trim()
    if (text) paragraphs.push({ index: paragraphs.length, text, inTable: Boolean(table), ...(table ? { table } : {}) })
  }
  // 修订容器按正文契约递归提取（moveFrom 除外）；fldSimple 与 AlternateContent(Choice) 正常提取文字，不计复杂结构。
  const knownContainers = new Set(["ins", "del", "moveTo", "AlternateContent"])
  const markers = new Set(["bookmarkStart", "bookmarkEnd", "proofErr", "permStart", "permEnd", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd", "tblGrid"])
  function collectTable(value: unknown, outer?: Paragraph["table"]) {
    if (outer) coverage.complex++ // 嵌套表格无法按表格坐标定位，记入覆盖并按外层单元格递归提取。
    else tableIndex++
    let row = 0
    for (const rowNode of children(value)) {
      if (!("tr" in rowNode)) continue
      row++
      let column = 0
      for (const cell of children(rowNode.tr)) {
        if (!("tc" in cell)) continue
        column++
        collectBlocks(children(cell.tc), outer ?? { index: tableIndex, row, column })
      }
    }
  }
  // 容器内部只递归提取段落，不再按未知容器重复计数。
  function collectInner(items: Node[], table?: Paragraph["table"]) {
    for (const node of items) for (const [key, value] of Object.entries(node)) {
      if (skipTree(key) || !Array.isArray(value)) continue
      if (key === "p") push(value, table)
      else if (key === "tbl") collectTable(value, table)
      else collectInner(children(value), table)
    }
  }
  // preserveOrder 保留 p/tbl 交错顺序及各个 run 的顺序；sdt/customXml 等未知块容器递归提取段落并记入复杂结构，不再整体拒绝。
  // complexKeys 成员已由 scanComplex 按出现计过一次，这里只递归提取，不再重复计数。
  function collectBlocks(items: Node[], table?: Paragraph["table"]) {
    for (const node of items) for (const [key, value] of Object.entries(node)) {
      if (skipTree(key) || key.endsWith("Pr") || markers.has(key)) continue
      if (key === "p") push(value, table)
      else if (key === "tbl") collectTable(value, table)
      else if (knownContainers.has(key) || complexKeys.has(key)) collectInner(children(value), table)
      else { coverage.complex++; collectInner(children(value), table) }
    }
  }
  collectBlocks(children(body.body))
  if (paragraphs.reduce((sum, item) => sum + item.text.length, 0) > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
  return { paragraphs, coverage }
}

export function paragraphsFromString(text: string): Paragraph[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .map((line, index) => ({ index, text: line, inTable: false }))
}
export function isDocxPath(path: string): boolean { return path.toLowerCase().endsWith(".docx") }

export async function readDocxInChild(bytes: Buffer, signal?: AbortSignal): Promise<{ paragraphs: Paragraph[]; coverage: ParseCoverage }> {
  signal?.throwIfAborted()
  const worker = resolve(process.cwd(), "scripts/generated/contract-reader.mjs")
  try { await access(worker) } catch { throw new ReviewError("REVIEW_PARSER_UNAVAILABLE") }
  return new Promise((accept, reject) => {
    const child = fork(/* turbopackIgnore: true */ worker, [], {
      execArgv: ["--max-old-space-size=512"], windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { NODE_ENV: "production" },
    })
    let settled = false
    const finish = (error?: Error, parsed?: { paragraphs: Paragraph[]; coverage: ParseCoverage }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      child.kill()
      if (error) reject(error)
      else accept(parsed ?? { paragraphs: [], coverage: noCoverage() })
    }
    const timer = setTimeout(() => finish(new ReviewError("REVIEW_DOCUMENT_TIMEOUT")), 60000)
    const abort = () => finish(new ReviewError("REVIEW_CANCELLED"))
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    child.once("error", () => finish(new ReviewError("REVIEW_PARSER_UNAVAILABLE")))
    child.once("exit", () => finish(new ReviewError("REVIEW_DOCUMENT_INVALID")))
    child.once("message", message => {
      const value = message as { valid?: boolean; paragraphs?: Paragraph[]; coverage?: ParseCoverage }
      if (value?.valid === true && Array.isArray(value.paragraphs)) finish(undefined, { paragraphs: value.paragraphs, coverage: value.coverage ?? noCoverage() })
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
  let parsed: { paragraphs: Paragraph[]; coverage: ParseCoverage }
  if (isDocxPath(path)) parsed = await readDocxInChild(bytes)
  else {
    let text: string
    try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes) }
    catch { throw new ReviewError("REVIEW_DOCUMENT_INVALID") }
    if (text.includes("\0")) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
    if (text.length > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
    parsed = { paragraphs: paragraphsFromString(text), coverage: noCoverage() }
  }
  if (!parsed.paragraphs.length) throw new ReviewError("REVIEW_INPUT_INVALID")
  return { paragraphs: parsed.paragraphs, complete: coverageComplete(parsed.coverage), warnings: coverageWarnings(parsed.coverage), sha256: createHash("sha256").update(bytes).digest("hex") }
}

export async function extractParagraphs(path: string): Promise<Paragraph[]> {
  return (await parseDocument(path)).paragraphs
}
