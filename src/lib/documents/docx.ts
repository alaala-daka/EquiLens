import { Unzip, UnzipInflate, strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { DOCX_TYPE } from "./types"

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 2000
const MAX_XML_BYTES = 10 * 1024 * 1024
const mainType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const packageNamespace = "http://schemas.openxmlformats.org/package/2006/relationships"
const stylesType = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"
const stylesXml = `<w:styles xmlns:w="${wordNamespace}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - level * 4}"/></w:rPr></w:style>`).join("")}</w:styles>`

export function blankDocx(): Blob {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const files = {
    "[Content_Types].xml": strToU8(`${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`),
    "_rels/.rels": strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "word/document.xml": strToU8(`${xml}<w:document xmlns:w="${wordNamespace}"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  }
  return new Blob([prepareDocxBytes(zipSync(files)) as Uint8Array<ArrayBuffer>], { type: DOCX_TYPE })
}

// Engine working copy only: valid minimal OOXML can omit styles and document rels.
// Originals and previously saved bytes are never replaced by this preparation.
export function prepareDocxBytes(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  if (files["word/styles.xml"] && files["word/_rels/document.xml.rels"]) return bytes
  files["word/_rels/document.xml.rels"] ??= strToU8(`<Relationships xmlns="${packageNamespace}"/>`)
  if (!files["word/styles.xml"]) {
    files["word/styles.xml"] = strToU8(stylesXml)
    const typeXml = strFromU8(files["[Content_Types].xml"])
    files["[Content_Types].xml"] = strToU8(typeXml.replace(/<\/(?:[\w.-]+:)?Types\s*>/, match => `<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/word/styles.xml" ContentType="${stylesType}"/>${match}`))
    const rels = strFromU8(files["word/_rels/document.xml.rels"])
    const relation = '<Relationship xmlns="' + packageNamespace + '" Id="equilensStyles' + crypto.randomUUID().replaceAll("-", "") + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    const closing = /<\/(?:[\w.-]+:)?Relationships\s*>/
    files["word/_rels/document.xml.rels"] = strToU8(closing.test(rels)
      ? rels.replace(closing, match => relation + match)
      : rels.replace(/<((?:[\w.-]+:)?Relationships)\b([^>]*?)\/>/, (_, name, attributes) => `<${name}${attributes}>${relation}</${name}>`))
  }
  return zipSync(files)
}

function invalid(message = "文件不是有效的 Word DOCX 文档。") { return new Error(message) }
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

// Check the directory before inflating; verify the actual stream independently below.
function directory(bytes: Uint8Array) {
  if (bytes.length < 22) throw invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x04034b50) throw invalid()
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw invalid()
  const count = view.getUint16(end + 10, true)
  if (!count || count > MAX_ENTRIES || count !== view.getUint16(end + 8, true)) throw invalid("DOCX 包条目数量超限或结构无效。")
  const entries = new Map<string, { size: number; crc: number }>()
  let offset = view.getUint32(end + 16, true)
  const start = offset
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid()
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    if (next > end || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) throw invalid()
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (flags & 0x41 || ![0, 8].includes(method) || flags !== view.getUint16(local + 6, true) || method !== view.getUint16(local + 8, true)) throw invalid("不支持加密或特殊压缩格式。")
    const localNameLength = view.getUint16(local + 26, true)
    if (name !== strFromU8(bytes.subarray(local + 30, local + 30 + localNameLength))) throw invalid()
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === ".." || part === ".") || /[\u0000-\u001f:%]/.test(name) || entries.has(name)) throw invalid("DOCX 包路径无效或重复。")
    if (/vba|activex|embeddings|\.zip$|\.doc[mx]$|\.bin$/i.test(name)) throw invalid("不支持宏、嵌入对象或嵌套文档。")
    total += size
    if (size > MAX_EXPANDED_BYTES || total > MAX_EXPANDED_BYTES) throw invalid("DOCX 解压大小超过 100 MiB。")
    entries.set(name, { size, crc: view.getUint32(offset + 16, true) })
    offset = next
  }
  if (offset !== end || offset - start !== view.getUint32(end + 12, true)) throw invalid()
  return entries
}

function visit(value: unknown, callback: (name: string, value: unknown) => void) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) { value.forEach(item => visit(item, callback)); return }
  for (const [name, child] of Object.entries(value)) { callback(name, child); visit(child, callback) }
}

export function validateDocxBytes(bytes: Uint8Array, expectedText?: string): string {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw invalid("文件大小须在 20 MiB 以内。")
  const entries = directory(bytes)
  const xmlFiles = new Map<string, string>()
  const found = new Set<string>()
  let expanded = 0
  const unzip = new Unzip(file => {
    const entry = entries.get(file.name)
    if (!entry || found.has(file.name)) throw invalid()
    found.add(file.name)
    let size = 0
    let crc = 0xffffffff
    const xml = /\.(?:xml|rels)$/i.test(file.name)
    const chunks: Uint8Array[] = []
    file.ondata = (error, data, final) => {
      if (error) throw invalid()
      size += data.length
      expanded += data.length
      if (size > entry.size || expanded > MAX_EXPANDED_BYTES || (xml && size > MAX_XML_BYTES)) throw invalid("DOCX 解压大小超限。")
      for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      if (xml) chunks.push(data)
      else if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4) throw invalid("不支持嵌套压缩文件。")
      if (final) {
        if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw invalid("DOCX 文件校验失败。")
        if (xml) {
          const output = new Uint8Array(size)
          let position = 0
          for (const chunk of chunks) { output.set(chunk, position); position += chunk.length }
          xmlFiles.set(file.name, strFromU8(output))
        }
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 32768) unzip.push(bytes.subarray(offset, offset + 32768), offset + 32768 >= bytes.length)
  if (found.size !== entries.size) throw invalid()
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: false })
  let typesValid = false
  let documentValid = false
  let rootRelationship = false
  let bodyText = ""
  for (const [name, text] of xmlFiles) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw invalid("DOCX XML 结构无效。")
    const parsed = parser.parse(text)
    if (name === "[Content_Types].xml") {
      visit(parsed, (key, value) => {
        if (key === "Override") {
          const overrides = Array.isArray(value) ? value : [value]
          typesValid ||= overrides.some(item => item?.["@_PartName"] === "/word/document.xml" && item?.["@_ContentType"] === mainType)
        }
        if (key === "@_ContentType" && /macroEnabled|oleObject|activex/i.test(String(value))) throw invalid("不支持活动内容。")
      })
    }
    if (name.endsWith(".rels")) {
      visit(parsed, (key, value) => {
        if (key !== "Relationship") return
        for (const relation of Array.isArray(value) ? value : [value]) {
          const target = String(relation?.["@_Target"] ?? "")
          if (relation?.["@_TargetMode"]?.toLowerCase() === "external" || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) throw invalid("文档包含外部资源，请移除外部链接后导入。")
          if (/attachedTemplate|oleObject|aFChunk/i.test(String(relation?.["@_Type"]))) throw invalid("不支持外部模板或嵌入内容。")
          if (name === "_rels/.rels" && /\/officeDocument$/.test(String(relation?.["@_Type"])) && target === "word/document.xml") rootRelationship = true
        }
      })
    }
    if (name === "word/document.xml") {
      documentValid = Boolean(parsed.document && Object.hasOwn(parsed.document, "body")) && text.includes(wordNamespace)
      const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: false }).parse(text)
      visit(ordered, (key, value) => {
        if (key === "t") {
          for (const run of Array.isArray(value) ? value : [value]) bodyText += typeof run === "string" ? run : String(run?.["#text"] ?? "")
        }
      })
    }
    if (/^word\/.*\.xml$/i.test(name)) {
      visit(parsed, key => {
        if (/PrChange$/.test(key) || ["txbxContent", "fldChar", "instrText", "ins", "del", "moveFrom", "moveTo", "altChunk", "object", "drawing", "pict", "gridSpan", "vMerge", "headerReference", "footerReference", "sdt", "commentRangeStart", "commentRangeEnd", "commentReference", "footnoteReference", "endnoteReference"].includes(key)) throw invalid("文档包含暂不支持的图片、页眉页脚、域、修订或复杂结构。")
      })
    }
  }
  if (!typesValid || !documentValid || !rootRelationship) throw invalid()
  if (expectedText !== undefined && bodyText !== expectedText) throw invalid("导出正文与编辑内容不一致，此次结果未保存，请重试。")
  return bodyText
}
