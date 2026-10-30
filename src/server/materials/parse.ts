import { inflateSync } from "node:zlib"
import { strFromU8, unzipSync } from "fflate"
import { XMLParser } from "fast-xml-parser"
import { validateDocxBytes } from "../../lib/documents/docx"
import type { CoverageFinding, CoverageFindingCode, MaterialFormat, ParseCoverage, ParsedFragment, ParsedMaterial } from "./types"

/** Demo input limits from spec §2: never silently truncate. */
export const MATERIAL_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  docxCharacters: 100_000,
  extractedCharacters: 200_000,
  pdfPages: 100,
  maxFindings: 100,
} as const

/**
 * Certificate image limits (spec 01 §9.3): 4 MiB, side <= 8192 px, <= 40 MP,
 * PNG/JPEG by real content. Images never enter material-parse and never claim
 * extracted full text.
 */
export const IMAGE_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  sidePixels: 8192,
  totalPixels: 40_000_000,
} as const

/** One fixed product message for every image acceptance failure (never leaks internals). */
export const IMAGE_MATERIAL_MESSAGE = "证照图片需为 4 MiB 以内的 PNG 或 JPEG，单边不超过 8192 像素且总像素不超过 4000 万。"

export type ImageInspection = { format: "png" | "jpeg"; width: number; height: number }

export class ParseFailure extends Error {
  constructor(readonly code: "INVALID_SOURCE" | "LIMIT_EXCEEDED", message: string, readonly coverage?: ParseCoverage) {
    super(message)
    this.name = "ParseFailure"
  }
}

const failedCoverage = (findings: CoverageFinding[], pageCount: number | null): ParseCoverage => ({
  status: "failed", findings, pageCount, textLength: 0,
})

export function detectMaterialFormat(bytes: Uint8Array): MaterialFormat | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf"
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "docx"
  if (bytes.length >= 3 && ((bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47))) return "image"
  return null
}

const readUint32Be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
const readUint16Be = (bytes: Uint8Array, offset: number): number => (bytes[offset] << 8) | bytes[offset + 1]

/**
 * Identify a PNG/JPEG image from its real bytes and read its pixel dimensions.
 * Returns null when the content is not a structurally readable PNG/JPEG; the
 * caller never trusts a file name or declared content type.
 */
export function inspectImage(bytes: Uint8Array): ImageInspection | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) return null
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  if (png) {
    // Signature (8) + first chunk length (4) + "IHDR" (4) + 13-byte IHDR header.
    if (bytes.length < 33) return null
    if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null
    if (readUint32Be(bytes, 8) !== 13) return null
    const width = readUint32Be(bytes, 16), height = readUint32Be(bytes, 20)
    if (!width || !height) return null
    return { format: "png", width, height }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null
      // Fill bytes are legal before a marker.
      while (bytes[offset + 1] === 0xff && offset + 2 < bytes.length) offset++
      const marker = bytes[offset + 1]
      offset += 2
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
      if (offset + 2 > bytes.length) return null
      const length = readUint16Be(bytes, offset)
      if (length < 2 || offset + length > bytes.length) return null
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        if (length < 7) return null
        const height = readUint16Be(bytes, offset + 3), width = readUint16Be(bytes, offset + 5)
        if (!width || !height) return null
        return { format: "jpeg", width, height }
      }
      offset += length
    }
    return null
  }
  return null
}

/** Validate an image material before it is stored: real PNG/JPEG content plus every limit. */
export function parseImageMaterial(bytes: Uint8Array): ImageInspection {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new ParseFailure("INVALID_SOURCE", IMAGE_MATERIAL_MESSAGE)
  if (bytes.byteLength > IMAGE_LIMITS.fileBytes) throw new ParseFailure("LIMIT_EXCEEDED", IMAGE_MATERIAL_MESSAGE)
  const image = inspectImage(bytes)
  if (!image) throw new ParseFailure("INVALID_SOURCE", IMAGE_MATERIAL_MESSAGE)
  if (image.width > IMAGE_LIMITS.sidePixels || image.height > IMAGE_LIMITS.sidePixels ||
    image.width * image.height > IMAGE_LIMITS.totalPixels) throw new ParseFailure("LIMIT_EXCEEDED", IMAGE_MATERIAL_MESSAGE)
  return image
}

export function parseMaterial(input: { bytes: Uint8Array; format: MaterialFormat }): ParsedMaterial {
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new ParseFailure("INVALID_SOURCE", "文件内容为空。")
  if (input.bytes.byteLength > MATERIAL_LIMITS.fileBytes) throw new ParseFailure("LIMIT_EXCEEDED", "文件超过 20 MiB 限制，请缩减后重试。")
  // Defensive: images have no parse snapshot and must never be parsed as documents.
  if (input.format === "image") throw new ParseFailure("INVALID_SOURCE", "图片材料不进入文档解析。")
  return input.format === "docx" ? parseDocx(input.bytes) : parsePdf(input.bytes)
}

// ---------------------------------------------------------------------------
// DOCX: structure-preserving paragraph/table extraction on top of the shared
// restricted OOXML validation (macros, external rels, zip bombs, expanded size).
// ---------------------------------------------------------------------------

type OrderedNode = Record<string, unknown>
const xmlParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: false })
const attribute = (attrs: Record<string, string>, name: string) => attrs[`@_${name}`] ?? attrs[`@_w:${name}`]
const childrenOf = (value: unknown): OrderedNode[] => Array.isArray(value) ? value as OrderedNode[] : []

function parseDocx(bytes: Uint8Array): ParsedMaterial {
  let inspection: ReturnType<typeof validateDocxBytes>
  try {
    inspection = validateDocxBytes(bytes)
  } catch (failure) {
    // Format/size/macro/external-resource validation rejects before the
    // original is stored (spec §6); only later content limits become states.
    throw new ParseFailure("INVALID_SOURCE", failure instanceof Error ? failure.message : "Word 文件无效。")
  }
  let documentXml: string
  try {
    const files = unzipSync(bytes)
    const xml = files["word/document.xml"]
    if (!xml) throw new Error("missing document.xml")
    documentXml = strFromU8(xml)
  } catch {
    throw new ParseFailure("INVALID_SOURCE", "Word 文件结构无效。")
  }
  let root: OrderedNode[]
  try {
    root = xmlParser.parse(documentXml)
  } catch {
    throw new ParseFailure("INVALID_SOURCE", "Word 正文结构无效。")
  }
  const body = findBody(root)
  if (!body) throw new ParseFailure("INVALID_SOURCE", "未找到 Word 正文。")
  const state: DocxState = { fragments: [], findings: [], headings: [], paragraph: 0, table: 0 }
  walkBody(body, state)
  const text = state.fragments.map(fragment => fragment.text).join("\n")
  const characters = [...text].length
  if (characters > MATERIAL_LIMITS.docxCharacters) throw new ParseFailure("LIMIT_EXCEEDED", "Word 正文超过 100,000 字符，请拆分后重试。")
  const findings = [...state.findings]
  if (inspection.structures.headerFooterRefs > 0) findings.push({ code: "header_footer", location: `页眉/页脚 ${inspection.structures.headerFooterRefs} 处（未提取正文外内容）` })
  if (inspection.structures.comments > 0) findings.push({ code: "comment", location: `批注 ${inspection.structures.comments} 处` })
  if (inspection.structures.notes > 0) findings.push({ code: "note", location: `脚注/尾注 ${inspection.structures.notes} 处` })
  if (inspection.structures.contentControls > 0) findings.push({ code: "content_control", location: `内容控件 ${inspection.structures.contentControls} 处` })
  if (inspection.structures.images > 0 && !findings.some(finding => finding.code === "embedded_image")) {
    findings.push({ code: "embedded_image", location: `图片 ${inspection.structures.images} 处` })
  }
  if (inspection.structures.textboxes > 0 && !findings.some(finding => finding.code === "textbox")) {
    findings.push({ code: "textbox", location: `文本框 ${inspection.structures.textboxes} 处` })
  }
  const unique = dedupe(findings)
  if (unique.some(finding => finding.code === "embedded_image" || finding.code === "textbox")) {
    unique.push({ code: "ocr_unavailable", location: "图片与文本框内容未做 OCR，未计入已提取全文" })
  }
  if (characters === 0) {
    throw new ParseFailure("INVALID_SOURCE", "未从 Word 文档中提取到可分析的文字。", failedCoverage(dedupe([...unique, { code: "no_text", location: "正文" }]), null))
  }
  const coverage: ParseCoverage = { status: unique.length ? "partial" : "available", findings: unique, pageCount: null, textLength: characters }
  return { format: "docx", parser: "docx-ooxml", parserVersion: "c2-docx-1", coverage, fragments: state.fragments, text }
}

type DocxState = {
  fragments: ParsedFragment[]
  findings: CoverageFinding[]
  headings: string[]
  paragraph: number
  table: number
}

function findBody(nodes: OrderedNode[]): OrderedNode[] | null {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === ":@" || key === "#text") continue
    if (key === "body") return childrenOf(value)
    const found = findBody(childrenOf(value))
    if (found) return found
  }
  return null
}

function walkBody(nodes: OrderedNode[], state: DocxState): void {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === ":@" || key === "#text") continue
    const children = childrenOf(value)
    if (key === "p") {
      state.paragraph++
      addParagraph(children, state)
    } else if (key === "tbl") {
      state.table++
      addTable(children, state)
    } else if (key === "sectPr") {
      scanStructures(children, "正文节属性", state)
    } else {
      // Unknown containers (e.g. sdt, customXml) are walked conservatively.
      if (key === "sdt") state.findings.push({ code: "content_control", location: `第 ${state.paragraph + 1} 段附近` })
      walkBody(children, state)
    }
  }
}

function addParagraph(nodes: OrderedNode[], state: DocxState): void {
  const location = `第 ${state.paragraph} 段`
  scanStructures(nodes, location, state)
  const text = paragraphText(nodes).replace(/\s+/g, " ").trim()
  const level = headingLevel(nodes)
  if (level) {
    state.headings.length = Math.max(0, level - 1)
    state.headings[level - 1] = text
  }
  const headingPath = state.headings.filter(value => value !== undefined && value !== "")
  if (text) {
    state.fragments.push({
      kind: "paragraph", order: state.fragments.length, page: null, paragraph: state.paragraph,
      headingPath: [...headingPath], tableIndex: null, row: null, column: null, text,
    })
  }
}

function addTable(nodes: OrderedNode[], state: DocxState): void {
  let row = 0
  for (const rowNode of nodes) for (const [key, value] of Object.entries(rowNode)) {
    if (key !== "tr") continue
    row++
    let column = 0
    for (const cellNode of childrenOf(value)) for (const [cellKey, cellValue] of Object.entries(cellNode)) {
      if (cellKey !== "tc") continue
      column++
      const location = `表格 ${state.table} 第 ${row} 行第 ${column} 列`
      scanStructures(childrenOf(cellValue), location, state)
      const text = tableCellText(childrenOf(cellValue)).replace(/\s+/g, " ").trim()
      if (!text) continue
      state.fragments.push({
        kind: "table", order: state.fragments.length, page: null, paragraph: null,
        headingPath: state.headings.filter(entry => entry !== undefined && entry !== ""),
        tableIndex: state.table, row, column, text,
      })
    }
  }
}

function paragraphText(nodes: OrderedNode[], skip = false): string {
  let out = ""
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === ":@" ) continue
    if (key === "#text") { if (!skip) out += String(value); continue }
    const nested = childrenOf(value)
    out += paragraphText(nested, skip || key === "del" || key === "delText" || key === "moveFrom" || key === "instrText")
  }
  return out
}

function tableCellText(nodes: OrderedNode[]): string {
  const parts: string[] = []
  const visit = (list: OrderedNode[]) => {
    for (const node of list) for (const [key, value] of Object.entries(node)) {
      if (key === ":@") continue
      if (key === "p") { parts.push(paragraphText(childrenOf(value))); continue }
      if (key === "tbl") continue
      visit(childrenOf(value))
    }
  }
  visit(nodes)
  return parts.join(" ")
}

function headingLevel(nodes: OrderedNode[]): number | null {
  const style = findAttribute(nodes, "pStyle", "val")
  if (style) {
    const match = /^heading\s*(\d)$/i.exec(style) ?? /^标题\s*(\d)$/.exec(style)
    if (match) return clampLevel(Number(match[1]))
  }
  const outline = findAttribute(nodes, "outlineLvl", "val")
  if (outline && /^\d+$/.test(outline)) return clampLevel(Number(outline) + 1)
  return null
}

const clampLevel = (level: number) => Math.min(9, Math.max(1, level))

function findAttribute(nodes: OrderedNode[], element: string, name: string): string | null {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === ":@" ) continue
    if (key === "#text") continue
    if (key === element) {
      const attrs = (node[":@"] ?? {}) as Record<string, string>
      return attribute(attrs, name) ?? null
    }
    const found = findAttribute(childrenOf(value), element, name)
    if (found !== null) return found
  }
  return null
}

const structuralCodes: Record<string, { code: CoverageFindingCode; label: string }> = {
  drawing: { code: "embedded_image", label: "图片" },
  pict: { code: "embedded_image", label: "图片" },
  txbxContent: { code: "textbox", label: "文本框" },
  ins: { code: "revision", label: "修订插入" },
  del: { code: "revision", label: "修订删除" },
  moveFrom: { code: "revision", label: "修订移动" },
  moveTo: { code: "revision", label: "修订移动" },
  gridSpan: { code: "merged_cell", label: "横向合并单元格" },
  vMerge: { code: "merged_cell", label: "纵向合并单元格" },
  commentReference: { code: "comment", label: "批注" },
  footnoteReference: { code: "note", label: "脚注" },
  endnoteReference: { code: "note", label: "尾注" },
  sdt: { code: "content_control", label: "内容控件" },
  headerReference: { code: "header_footer", label: "页眉" },
  footerReference: { code: "header_footer", label: "页脚" },
}

function scanStructures(nodes: OrderedNode[], location: string, state: DocxState): void {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === ":@" ) continue
    if (key === "#text") continue
    const mapped = structuralCodes[key] ?? (/(?:PrChange|Change)$/.test(key) ? { code: "revision" as const, label: "格式修订" } : null)
    if (mapped) {
      if (state.findings.length < MATERIAL_LIMITS.maxFindings) state.findings.push({ code: mapped.code, location: `${location}（${mapped.label}）` })
    }
    scanStructures(childrenOf(value), location, state)
  }
}

function dedupe(findings: CoverageFinding[]): CoverageFinding[] {
  const seen = new Set<string>()
  const out: CoverageFinding[] = []
  for (const finding of findings) {
    const key = `${finding.code}|${finding.location}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finding)
    if (out.length >= MATERIAL_LIMITS.maxFindings) break
  }
  return out
}

// ---------------------------------------------------------------------------
// PDF: only text extraction with explicitly bounded support. Page-level text,
// Flate streams and literal strings are read; CID/hex font encodings, images,
// encryption and unsupported filters are surfaced as coverage limits instead
// of being presented as complete extracted text.
// ---------------------------------------------------------------------------

function parsePdf(bytes: Uint8Array): ParsedMaterial {
  const source = Buffer.from(bytes).toString("latin1")
  if (/\/Encrypt\b/.test(source)) throw new ParseFailure("INVALID_SOURCE", "PDF 已加密，无法处理。")
  const objects = pdfObjects(source)
  const pages: { number: number; contents: number[] }[] = []
  let embeddedImages = 0
  let cidFonts = 0
  let externalLinks = 0
  let unsupportedFilter = false
  for (const [number, body] of objects) {
    if (/\/Subtype\s*\/Image\b/.test(body)) embeddedImages++
    if (/\/Subtype\s*\/Type0\b/.test(body) || /\/Encoding\s*\/Identity-H\b/.test(body)) cidFonts++
    if (/\/URI\b/.test(body)) externalLinks++
    if (/\/Type\s*\/Page\b/.test(body) && !/\/Type\s*\/Pages\b/.test(body)) {
      const inline = /\/Contents\s+(\d+)\s+0\s+R\b/.exec(body)
      const multiple = /\/Contents\s*\[([^\]]*)\]/.exec(body)
      const refs = multiple ? [...multiple[1].matchAll(/(\d+)\s+0\s+R/g)].map(match => Number(match[1])) : inline ? [Number(inline[1])] : []
      pages.push({ number, contents: refs })
    }
  }
  if (pages.length > MATERIAL_LIMITS.pdfPages) throw new ParseFailure("LIMIT_EXCEEDED", "PDF 超过 100 页限制，请拆分后重试。")
  pages.sort((left, right) => left.number - right.number)
  const findings: CoverageFinding[] = []
  const fragments: ParsedFragment[] = []
  let textLength = 0
  const pushLines = (lines: string[], pageNumber: number | null) => {
    for (const line of lines) {
      textLength += [...line].length
      if (textLength > MATERIAL_LIMITS.extractedCharacters) throw new ParseFailure("LIMIT_EXCEEDED", "PDF 提取文字超过 200,000 字符，请拆分后重试。")
      fragments.push({
        kind: "paragraph", order: fragments.length, page: pageNumber, paragraph: null,
        headingPath: [], tableIndex: null, row: null, column: null, text: line,
      })
    }
  }
  const extractObject = (objectNumber: number, pageNumber: number | null): void => {
    const body = objects.get(objectNumber)
    if (!body) return
    for (const stream of pdfStreams(body)) {
      if (/\/Subtype\s*\/Image\b/.test(stream.dictionary)) { embeddedImages++; continue }
      const decoded = decodePdfStream(stream.data, stream.dictionary)
      if (decoded.unsupported) { unsupportedFilter = true; continue }
      const extracted = pdfText(decoded.content)
      pushLines(extracted, pageNumber)
    }
  }
  if (pages.length) {
    pages.forEach((page, index) => {
      for (const reference of page.contents) extractObject(reference, index + 1)
    })
  } else {
    const contentObjects = [...objects.entries()].filter(([, body]) => /stream\r?\n/.test(body))
    for (const [number] of contentObjects) extractObject(number, null)
  }
  if (embeddedImages > 0) {
    findings.push({ code: "embedded_image", location: `PDF 图像对象 ${embeddedImages} 处` })
    findings.push({ code: "ocr_unavailable", location: "证照/扫描图像未做 OCR，未计入已提取全文" })
  }
  if (cidFonts > 0) findings.push({ code: "cid_font", location: `PDF 使用 CID 字体 ${cidFonts} 处，文字编码未完整解析` })
  if (externalLinks > 0) findings.push({ code: "external_link", location: `PDF 外部链接 ${externalLinks} 处` })
  if (unsupportedFilter) findings.push({ code: "unsupported_filter", location: "部分内容流未解码，提取范围不完整" })
  if (!pages.length && fragments.length) findings.push({ code: "unsupported_structure", location: "PDF 页树未解析，页码未定位" })
  const pageCount = pages.length || null
  if (!fragments.length) {
    const failureFindings: CoverageFinding[] = embeddedImages > 0
      ? [{ code: "scanned_image", location: "疑似扫描 PDF，未提取到文字" }, { code: "ocr_unavailable", location: "OCR 未验证，不提供全文" }]
      : unsupportedFilter
        ? [{ code: "unsupported_filter", location: "PDF 内容流编码不受支持，未提取到文字" }]
        : cidFonts > 0
          ? [{ code: "cid_font", location: "PDF 字体编码不受支持，未提取到文字" }]
          : [{ code: "no_text", location: "PDF 未提取到可用文字" }]
    throw new ParseFailure("INVALID_SOURCE", embeddedImages > 0 ? "该 PDF 疑似扫描件，暂不支持文字提取，请改用可复制文字的 PDF。" : "该 PDF 未提取到可用文字。", failedCoverage(failureFindings, pageCount))
  }
  const unique = dedupe(findings)
  const coverage: ParseCoverage = { status: unique.length ? "partial" : "available", findings: unique, pageCount, textLength }
  return { format: "pdf", parser: "pdf-text", parserVersion: "c2-pdf-1", coverage, fragments, text: fragments.map(fragment => fragment.text).join("\n") }
}

function pdfObjects(source: string): Map<number, string> {
  const objects = new Map<number, string>()
  const pattern = /(\d+)\s+0\s+obj\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const start = match.index + match[0].length
    const end = source.indexOf("endobj", start)
    if (end < 0) break
    objects.set(Number(match[1]), source.slice(start, end))
    pattern.lastIndex = end + 6
  }
  return objects
}

function pdfStreams(body: string): { dictionary: string; data: Uint8Array }[] {
  const streams: { dictionary: string; data: Uint8Array }[] = []
  const pattern = /\bstream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    const start = match.index + match[0].length
    const end = body.indexOf("endstream", start)
    if (end < 0) break
    streams.push({ dictionary: body.slice(0, match.index), data: Buffer.from(body.slice(start, end), "latin1") })
    pattern.lastIndex = end + 9
  }
  return streams
}

function decodePdfStream(data: Uint8Array, dictionary: string): { content: string; unsupported: boolean } {
  const filters: string[] = []
  for (const match of dictionary.matchAll(/\/Filter\s*(?:\[([^\]]*)\]|\/([A-Za-z0-9]+))/g)) {
    if (match[1] !== undefined) for (const inner of match[1].matchAll(/\/([A-Za-z0-9]+)/g)) filters.push(inner[1])
    else if (match[2]) filters.push(match[2])
  }
  if (!filters.length) return { content: Buffer.from(data).toString("latin1"), unsupported: false }
  if (filters.length === 1 && /^(?:FlateDecode|Fl)$/.test(filters[0])) {
    try {
      return { content: inflateSync(Buffer.from(data), { maxOutputLength: 8 * 1024 * 1024 }).toString("latin1"), unsupported: false }
    } catch {
      return { content: "", unsupported: true }
    }
  }
  return { content: "", unsupported: true }
}

function literalString(content: string, start: number): { value: string; next: number } {
  let depth = 0
  let index = start
  let value = ""
  while (index < content.length) {
    const char = content[index]
    if (char === "\\") {
      const escaped = content[index + 1]
      if (escaped === undefined) { index++; break }
      if (escaped === "n") value += "\n"
      else if (escaped === "r") value += "\r"
      else if (escaped === "t") value += "\t"
      else if (escaped === "b") value += "\b"
      else if (escaped === "f") value += "\f"
      else if (/[0-7]/.test(escaped)) {
        const octal = /^[0-7]{1,3}/.exec(content.slice(index + 1))![0]
        value += String.fromCharCode(parseInt(octal, 8))
        index += octal.length + 1
        continue
      } else if (escaped === "\r" || escaped === "\n") {
        index += escaped === "\r" && content[index + 2] === "\n" ? 3 : 2
        continue
      } else value += escaped
      index += 2
      continue
    }
    if (char === "(") { depth++; if (depth > 1) value += char; index++; continue }
    if (char === ")") {
      depth--
      if (depth === 0) return { value, next: index + 1 }
      value += char
      index++
      continue
    }
    value += char
    index++
  }
  return { value, next: index }
}

function decodeLiteral(value: string): string {
  const bytes = Buffer.from(value, "latin1")
  let text: string
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes.subarray(2))
  else text = bytes.toString("latin1")
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
}

function pdfText(content: string): string[] {
  const lines: string[] = []
  let current = ""
  let pending: string[] = []
  let inText = false
  let index = 0
  const flush = () => {
    const line = current.replace(/\s+$/, "").trim()
    if (line) lines.push(line)
    current = ""
  }
  while (index < content.length) {
    const char = content[index]
    if (char === "%") {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") index++
      continue
    }
    if (char === "(") {
      const parsed = literalString(content, index)
      pending.push(decodeLiteral(parsed.value))
      index = parsed.next
      continue
    }
    if (char === "<" && content[index + 1] !== "<") {
      const end = content.indexOf(">", index)
      if (end < 0) break
      index = end + 1
      continue
    }
    if (/[A-Za-z*'"]/.test(char)) {
      let end = index
      while (end < content.length && /[A-Za-z*'"]/.test(content[end])) end++
      const operator = content.slice(index, end)
      index = end
      if (operator === "BT") { inText = true; continue }
      if (operator === "ET") { flush(); inText = false; pending = []; continue }
      if (!inText) continue
      if (operator === "Tj" || operator === "'" || operator === '"') {
        current += pending.join("")
        pending = []
        if (operator !== "Tj") flush()
      } else if (operator === "TJ") {
        current += pending.join("")
        pending = []
      } else if (operator === "Td" || operator === "TD" || operator === "T*" || operator === "Tm") {
        flush()
      } else {
        pending = []
      }
      continue
    }
    index++
  }
  if (current.trim()) flush()
  return lines
}
