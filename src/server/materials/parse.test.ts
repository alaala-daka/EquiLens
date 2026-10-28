import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateSync } from "node:zlib"
import { strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../lib/documents/docx"
import { MATERIAL_LIMITS, ParseFailure, detectMaterialFormat, parseMaterial } from "./parse"

const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

async function docx(body: string): Promise<Uint8Array> {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
  return zipSync(files)
}

const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const heading = (text: string) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`

/** UTF-16BE literal string with BOM hex, as a PDF text-string literal body. */
function pdfLiteral(text: string): string {
  const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])
  let literal = ""
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    literal += char === "(" || char === ")" || char === "\\" ? `\\${char}` : char
  }
  return literal
}

function pdf(objects: string[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")]
  objects.forEach((body, index) => {
    parts.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1"))
  })
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"))
  return new Uint8Array(Buffer.concat(parts))
}

function textPdf(content: string, extraDictionary = ""): Uint8Array {
  const stream = `\n${content}\n`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} ${extraDictionary}>>\nstream${stream}endstream`,
  ]
  return pdf(objects)
}

test("C2 parse: DOCX keeps heading paths, paragraph order and table row/column locations", async () => {
  const bytes = await docx([
    heading("第一章 合同价款"),
    paragraph("合同价税合计人民币 100,000 元。"),
    `<w:tbl><w:tr>${cell("项目")}${cell("金额")}</w:tr><w:tr>${cell("合同价")}${cell("100000")}</w:tr></w:tbl>`,
    paragraph("付款期限为验收后三十日。"),
  ].join(""))
  const parsed = parseMaterial({ bytes, format: "docx" })
  assert.equal(parsed.format, "docx")
  assert.equal(parsed.coverage.status, "available")
  assert.deepEqual(parsed.coverage.findings, [])
  assert.equal(parsed.coverage.pageCount, null)
  assert.deepEqual(parsed.fragments.map(fragment => ({
    kind: fragment.kind, text: fragment.text, paragraph: fragment.paragraph,
    headingPath: fragment.headingPath, tableIndex: fragment.tableIndex, row: fragment.row, column: fragment.column,
  })), [
    { kind: "paragraph", text: "第一章 合同价款", paragraph: 1, headingPath: ["第一章 合同价款"], tableIndex: null, row: null, column: null },
    { kind: "paragraph", text: "合同价税合计人民币 100,000 元。", paragraph: 2, headingPath: ["第一章 合同价款"], tableIndex: null, row: null, column: null },
    { kind: "table", text: "项目", paragraph: null, headingPath: ["第一章 合同价款"], tableIndex: 1, row: 1, column: 1 },
    { kind: "table", text: "金额", paragraph: null, headingPath: ["第一章 合同价款"], tableIndex: 1, row: 1, column: 2 },
    { kind: "table", text: "合同价", paragraph: null, headingPath: ["第一章 合同价款"], tableIndex: 1, row: 2, column: 1 },
    { kind: "table", text: "100000", paragraph: null, headingPath: ["第一章 合同价款"], tableIndex: 1, row: 2, column: 2 },
    { kind: "paragraph", text: "付款期限为验收后三十日。", paragraph: 3, headingPath: ["第一章 合同价款"], tableIndex: null, row: null, column: null },
  ])
  assert.equal(parsed.text.includes("100,000"), true)
})

test("C2/AC-24: DOCX images, textboxes, revisions and merged cells are partial coverage, not full text", async () => {
  const bytes = await docx([
    paragraph("正文条款一。"),
    `<w:p><w:r><w:drawing/></w:r></w:p>`,
    `<w:p><w:r><w:ins><w:r><w:t>修订新增</w:t></w:r></w:ins></w:r></w:p>`,
    `<w:p><w:r><w:txbxContent><w:p><w:r><w:t>文本框内容</w:t></w:r></w:p></w:txbxContent></w:r></w:p>`,
    `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>合并内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  ].join(""))
  const parsed = parseMaterial({ bytes, format: "docx" })
  assert.equal(parsed.coverage.status, "partial")
  const codes = parsed.coverage.findings.map(finding => finding.code)
  for (const code of ["embedded_image", "ocr_unavailable", "revision", "textbox", "merged_cell"] as const) assert.ok(codes.includes(code), code)
  assert.ok(parsed.coverage.findings.some(finding => /第 2 段/.test(finding.location)))
  assert.ok(parsed.fragments.some(fragment => fragment.text === "正文条款一。"))
})

test("C2: DOCX format validation rejects malformed packages before storage", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])
  await assert.rejects(async () => parseMaterial({ bytes, format: "docx" }), (failure: unknown) => {
    assert.ok(failure instanceof ParseFailure)
    assert.equal(failure.code, "INVALID_SOURCE")
    assert.equal((failure as ParseFailure).coverage, undefined)
    return true
  })
})

test("C2: DOCX character limit rejects instead of silently truncating", async () => {
  const bytes = await docx(paragraph("x".repeat(MATERIAL_LIMITS.docxCharacters + 1)))
  await assert.rejects(async () => parseMaterial({ bytes, format: "docx" }), (failure: unknown) => {
    assert.ok(failure instanceof ParseFailure)
    assert.equal(failure.code, "LIMIT_EXCEEDED")
    return true
  })
})

test("C2/AC-02: text PDF keeps page numbers and extracted fragments", () => {
  const bytes = textPdf(`BT /F1 12 Tf 72 720 Td (${pdfLiteral("第一部分 合同价款")}) Tj 0 -18 Td (${pdfLiteral("合同价 100000 元")}) Tj ET`)
  assert.equal(detectMaterialFormat(bytes), "pdf")
  const parsed = parseMaterial({ bytes, format: "pdf" })
  assert.equal(parsed.coverage.status, "available")
  assert.equal(parsed.coverage.pageCount, 1)
  assert.deepEqual(parsed.fragments.map(fragment => ({ page: fragment.page, text: fragment.text })), [
    { page: 1, text: "第一部分 合同价款" },
    { page: 1, text: "合同价 100000 元" },
  ])
  assert.equal(parsed.text.includes("合同价款"), true)
})

test("C2: Flate-compressed text PDF streams are decoded", () => {
  const content = Buffer.from(`BT /F1 12 Tf 72 700 Td (${pdfLiteral("验收合格后付款")}) Tj ET`, "latin1")
  const compressed = deflateSync(content).toString("latin1")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed}\nendstream`,
  ]
  const bytes = pdf(objects)
  const parsed = parseMaterial({ bytes, format: "pdf" })
  assert.equal(parsed.coverage.status, "available")
  assert.deepEqual(parsed.fragments.map(fragment => fragment.text), ["验收合格后付款"])
})

test("C2/AC-02: scanned PDF is failed coverage and never presented as extracted text", () => {
  const bytes = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
    "<< /Length 34 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream",
    "<< /Type /XObject /Subtype /Image /Width 100 /Height 100 >>",
  ])
  assert.doesNotThrow(() => detectMaterialFormat(bytes))
  assert.throws(() => parseMaterial({ bytes, format: "pdf" }), (failure: unknown) => {
    assert.ok(failure instanceof ParseFailure)
    assert.equal(failure.code, "INVALID_SOURCE")
    assert.equal(failure.coverage?.status, "failed")
    const codes = failure.coverage?.findings.map(finding => finding.code) ?? []
    assert.ok(codes.includes("scanned_image"), String(codes))
    assert.ok(codes.includes("ocr_unavailable"), String(codes))
    return true
  })
})

test("C2/AC-21: mixed text and scanned PDF pages stay partial, never complete", () => {
  const text = `\nBT /F1 12 Tf 72 700 Td (${pdfLiteral("第一页正文")}) Tj ET\n`
  const bytes = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream${text}endstream`,
    "<< /Type /XObject /Subtype /Image /Width 100 /Height 100 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
    "<< /Length 34 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream",
  ])
  const parsed = parseMaterial({ bytes, format: "pdf" })
  assert.equal(parsed.coverage.status, "partial")
  assert.equal(parsed.coverage.pageCount, 2)
  assert.deepEqual(parsed.fragments.map(fragment => ({ page: fragment.page, text: fragment.text })), [{ page: 1, text: "第一页正文" }])
  const codes = parsed.coverage.findings.map(finding => finding.code)
  assert.ok(codes.includes("embedded_image"))
  assert.ok(codes.includes("ocr_unavailable"))
})

test("C2: encrypted PDF and over-limit page count are rejected", () => {
  const encrypted = textPdf("BT (机密) Tj ET", "/Encrypt 9 0 R ")
  assert.throws(() => parseMaterial({ bytes: encrypted, format: "pdf" }), ParseFailure)

  const pages = Array.from({ length: 101 }, (_, index) => `<< /Type /Page /Parent 2 0 R ${index === 0 ? "/Contents 200 0 R" : ""} >>`)
  const bytes = pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>", ...pages])
  assert.throws(() => parseMaterial({ bytes, format: "pdf" }), (failure: unknown) => {
    assert.ok(failure instanceof ParseFailure)
    assert.equal((failure as ParseFailure).code, "LIMIT_EXCEEDED")
    return true
  })
})

test("C2: unsupported format detection does not trust file extensions", () => {
  assert.equal(detectMaterialFormat(new TextEncoder().encode("hello")), null)
  assert.equal(detectMaterialFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "pdf")
  assert.equal(detectMaterialFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "image")
})
