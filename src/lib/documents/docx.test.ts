import assert from "node:assert/strict"
import { test } from "node:test"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx, prepareDocxBytes, validateDocxBytes } from "./docx"
import { emptyCounts } from "./structures"
import { downloadName } from "./types"

async function fixture(change?: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  change?.(files)
  return zipSync(files)
}
const documentXml = (files: Record<string, Uint8Array>) => strFromU8(files["word/document.xml"])
const setDocument = (files: Record<string, Uint8Array>, xml: string) => { files["word/document.xml"] = strToU8(xml) }
const withBody = (body: string) => (files: Record<string, Uint8Array>) =>
  setDocument(files, documentXml(files).replace("<w:p/>", body))

test("WD-01: blank DOCX has a valid package and main part", async () => {
  validateDocxBytes(new Uint8Array(await blankDocx().arrayBuffer()))
})

test("WD-01/05: editor preparation adds optional parts without changing main text", async () => {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  delete files["word/styles.xml"]
  delete files["word/_rels/document.xml.rels"]
  files["[Content_Types].xml"] = strToU8(strFromU8(files["[Content_Types].xml"]).replace(/<Override[^>]*PartName="\/word\/styles.xml"[^>]*\/>/, ""))
  const original = zipSync(files)
  const prepared = prepareDocxBytes(original)
  validateDocxBytes(prepared)
  assert.deepEqual(unzipSync(prepared)["word/document.xml"], files["word/document.xml"])
  assert.ok(unzipSync(prepared)["word/styles.xml"])
  assert.equal(unzipSync(original)["word/styles.xml"], undefined)
})

test("WD-09: accept Chinese paragraphs and simple tables", async () => {
  const bytes = await fixture(files => {
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", "<w:p><w:r><w:t>工程合同：付款期限为三十日。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>价款</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"))
  })
  assert.doesNotThrow(() => validateDocxBytes(bytes))
})

test("WD-08: exported text must match the edit snapshot, including numeric strings and entities", async () => {
  const bytes = await fixture(files => {
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", '<w:p><w:r><w:t xml:space="preserve"> 001.00 &amp; 甲方 </w:t></w:r><w:r><w:t>三十日</w:t></w:r></w:p>'))
  })
  assert.equal(validateDocxBytes(bytes, { text: " 001.00 & 甲方 三十日", structures: emptyCounts() }).text, " 001.00 & 甲方 三十日")
  assert.throws(() => validateDocxBytes(bytes, { text: " 001.00 & 甲方 四十五日", structures: emptyCounts() }), /正文与编辑内容不一致/)
})

test("WD-08: export comparison preserves paragraph/table interleaving", async () => {
  const bytes = await fixture(files => {
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", '<w:p><w:r><w:t>前文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>后文</w:t></w:r></w:p>'))
  })
  assert.equal(validateDocxBytes(bytes, { text: "前文表格后文", structures: emptyCounts() }).text, "前文表格后文")
})

test("WD-09: reject disguised, truncated, corrupted and missing-part packages", async () => {
  assert.throws(() => validateDocxBytes(strToU8("<html>Word</html>")))
  const bytes = await fixture()
  assert.throws(() => validateDocxBytes(bytes.subarray(0, bytes.length - 4)))
  const corrupt = Uint8Array.from(bytes)
  corrupt[70] ^= 0xff
  assert.throws(() => validateDocxBytes(corrupt))
  assert.throws(() => validateDocxBytes(zipSync({ "test.txt": strToU8("test") })))
})

test("WD-09: reject remote relationships and XML entities", async () => {
  for (const extra of [
    '<Relationship Id="remote" Type="image" TargetMode="External" Target="https://example.com/tracker.png"/>',
    '<Relationship Id="remote" Type="image" Target="https://example.com/tracker.png"/>',
  ]) {
    const bytes = await fixture(files => { files["word/_rels/document.xml.rels"] = strToU8(`<Relationships>${extra}</Relationships>`) })
    assert.throws(() => validateDocxBytes(bytes), /外部资源/)
  }
  const bytes = await fixture(files => { files["word/document.xml"] = strToU8('<!DOCTYPE test [<!ENTITY data SYSTEM "file:///secret">]><test/>') })
  assert.throws(() => validateDocxBytes(bytes), /XML/)
})

test("WD-09: reject macros, path traversal and nested archives", async () => {
  for (const name of ["word/vbaProject.bin", "../outside.xml", "word/embeddings/test.docx", "word/data.zip"]) {
    assert.throws(() => validateDocxBytes(awaitless(name)))
  }
  function awaitless(name: string) { return zipSync({ [name]: strToU8("test") }) }
  for (const tag of ["ins", "del", "txbxContent", "instrText", "gridSpan", "drawing"]) {
    const bytes = await fixture(files => { files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", `<w:${tag}/>`)) })
    assert.doesNotThrow(() => validateDocxBytes(bytes))
  }
})

test("WD-09: reject file, entry and expansion limits before opening", async () => {
  assert.throws(() => validateDocxBytes(new Uint8Array(20 * 1024 * 1024 + 1)), /20 MiB/)
  const files: Record<string, Uint8Array> = {}
  for (let index = 0; index < 2001; index++) files[`f${index}`] = new Uint8Array()
  assert.throws(() => validateDocxBytes(zipSync(files)), /数量超限/)
  const bytes = await fixture()
  const view = new DataView(bytes.buffer)
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 101 * 1024 * 1024, true); break }
  }
  assert.throws(() => validateDocxBytes(bytes), /100 MiB/)
})

test("WD-08: safe Word download names have one extension", () => {
  assert.equal(downloadName("合同.docx.DOCX"), "合同.docx")
  assert.equal(downloadName("a/b:c*?"), "a_b_c__.docx")
  assert.equal(downloadName("  "), "未命名文档.docx")
})

test("WD-13: 图片、页眉页脚、域、文本框、合并单元格放行并计入清单", async () => {
  const bytes = await fixture(withBody(
    '<w:p><w:r><w:drawing><w:inline/></w:drawing></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>目录结果</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'))
  const files = unzipSync(bytes)
  setDocument(files, documentXml(files).replace("<w:tc>", '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'))
  const inspection = validateDocxBytes(zipSync(files))
  assert.equal(inspection.structures.images, 1)
  assert.equal(inspection.structures.fields.complex, 1)
  assert.equal(inspection.structures.mergedCells, 1)
  assert.equal(inspection.text, "目录结果合并")
})

test("WD-13: 修订标记放行；插入计入正文、删除与 moveFrom 不计入", async () => {
  const bytes = await fixture(withBody(
    '<w:p><w:ins w:id="1" w:author="张三"><w:r><w:t>新增</w:t></w:r></w:ins>' +
    '<w:del w:id="2" w:author="张三"><w:r><w:delText>删除</w:delText></w:r></w:del>' +
    '<w:moveFrom w:id="3"><w:r><w:t>移出</w:t></w:r></w:moveFrom>' +
    '<w:moveTo w:id="4"><w:r><w:t>移入</w:t></w:r></w:moveTo></w:p>'))
  const inspection = validateDocxBytes(bytes)
  assert.deepEqual(inspection.structures.revisions, { insertions: 1, deletions: 1, moves: 2, formatChanges: 0 })
  assert.equal(inspection.text, "新增移入")
})

test("WD-13: 文本框 Choice/Fallback 双份存储只计一次", async () => {
  const box = '<w:txbxContent><w:p><w:r><w:t>框内文字</w:t></w:r></w:p></w:txbxContent>'
  const bytes = await fixture(withBody(
    `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" Requires="wps"><w:drawing><w:txbx>${box}</w:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`))
  const inspection = validateDocxBytes(bytes)
  assert.equal(inspection.structures.textboxes, 1)
  assert.equal(inspection.structures.images, 1)
  assert.equal(inspection.text, "框内文字")
})

test("WD-13: 简单域、页眉页脚、批注、脚注、内容控件放行并计入清单", async () => {
  const bytes = await fixture(files => {
    withBody(
      '<w:p><w:sdt><w:sdtContent><w:r><w:t>控件</w:t></w:r></w:sdtContent></w:sdt>' +
      '<w:r><w:commentReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r>' +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>' +
      '<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr></w:pPr></w:p>')(files)
    files["word/header1.xml"] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>')
  })
  const inspection = validateDocxBytes(bytes)
  assert.equal(inspection.structures.contentControls, 1)
  assert.equal(inspection.structures.comments, 1)
  assert.equal(inspection.structures.notes, 1)
  assert.equal(inspection.structures.fields.simple, 1)
  assert.equal(inspection.structures.headerFooterRefs, 2)
  assert.equal(inspection.text.includes("页眉文字"), false)
  assert.equal(inspection.text.includes("控件1"), true)
})

test("WD-14: expected 传入时执行正文与结构对账", async () => {
  const bytes = await fixture(withBody('<w:p><w:r><w:drawing><w:inline/></w:drawing></w:r><w:r><w:t>正文</w:t></w:r></w:p>'))
  assert.throws(() => validateDocxBytes(bytes, { text: "别的", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }), /导出正文与编辑内容不一致/)
  assert.throws(() => validateDocxBytes(bytes, { text: "正文", structures: { images: 2, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }), /图片未保留/)
  assert.doesNotThrow(() => validateDocxBytes(bytes, { text: "正文", structures: { images: 1, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }))
})

test("WD-09: 安全拒绝保持不变（宏、外链、嵌套压缩、altChunk、object）", async () => {
  const bytes = await fixture(withBody('<w:p><w:altChunk r:id="rIdA"/></w:p>'))
  assert.throws(() => validateDocxBytes(bytes), /嵌入内容|暂不支持|外部资源|无效/)
  const objectBytes = await fixture(withBody('<w:p><w:object/></w:p>'))
  assert.throws(() => validateDocxBytes(objectBytes), /嵌入内容|暂不支持|外部资源|无效/)
})
