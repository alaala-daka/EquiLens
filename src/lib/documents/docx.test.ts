import assert from "node:assert/strict"
import { test } from "node:test"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx, docxFromParagraphs, prepareDocxBytes, validateDocxBytes } from "./docx"
import { downloadName } from "./types"

async function fixture(change?: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  change?.(files)
  return zipSync(files)
}

test("WD-01: blank DOCX has a valid package and main part", async () => {
  validateDocxBytes(new Uint8Array(await blankDocx().arrayBuffer()))
})

test("WD-09/UI: clean copy rebuilds validated paragraphs and escapes XML", async () => {
  const bytes = new Uint8Array(await (await docxFromParagraphs(["第一段 & < >", "", "第二段"])).arrayBuffer())
  assert.equal(validateDocxBytes(bytes), "第一段 & < >第二段")
  const empty = new Uint8Array(await (await docxFromParagraphs([""])).arrayBuffer())
  assert.equal(validateDocxBytes(empty), "")
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
  assert.equal(validateDocxBytes(bytes, " 001.00 & 甲方 三十日"), " 001.00 & 甲方 三十日")
  assert.throws(() => validateDocxBytes(bytes, " 001.00 & 甲方 四十五日"), /正文与编辑内容不一致/)
})

test("WD-08: export comparison preserves paragraph/table interleaving", async () => {
  const bytes = await fixture(files => {
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", '<w:p><w:r><w:t>前文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>后文</w:t></w:r></w:p>'))
  })
  assert.equal(validateDocxBytes(bytes, "前文表格后文"), "前文表格后文")
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

test("WD-09: reject macros, path traversal, nested archives and unverified features", async () => {
  for (const name of ["word/vbaProject.bin", "../outside.xml", "word/embeddings/test.docx", "word/data.zip"]) {
    assert.throws(() => validateDocxBytes(awaitless(name)))
  }
  function awaitless(name: string) { return zipSync({ [name]: strToU8("test") }) }
  for (const tag of ["ins", "del", "txbxContent", "instrText", "gridSpan", "drawing"]) {
    const bytes = await fixture(files => { files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", `<w:${tag}/>`)) })
    assert.throws(() => validateDocxBytes(bytes), /暂不支持/)
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
