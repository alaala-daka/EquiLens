import assert from "node:assert/strict"
import { test } from "node:test"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../../src/lib/documents/docx"
import { structureFixtures } from "../../../src/lib/documents/structure-fixtures"
import { coverageComplete, parseDocxBytes, parseDocument, paragraphsFromString } from "../src/document"

async function withBody(body: string) {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", body))
  return zipSync(files)
}
const p = (text: string) => "<w:p><w:r><w:t>" + text + "</w:t></w:r></w:p>"

test("AC-03/24：DOCX 按正文/表格交错顺序提取，保留行列且样式不污染原文", async () => {
  const body = p("表格之前") +
    '<w:tbl><w:tr><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>' +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>付款</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve"> 三十日</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' + p("表格之后")
  const { paragraphs } = parseDocxBytes(await withBody(body))
  assert.deepEqual(paragraphs.map(item => item.text), ["表格之前", "付款 三十日", "表格之后"])
  assert.deepEqual(paragraphs[1].table, { index: 1, row: 1, column: 1 })
  assert.equal(paragraphs[0].inTable, false)
  assert.equal(paragraphs[2].index, 2)
})

test("AC-24: 修订与复杂结构不再拒绝，覆盖记入 coverage 且 complete 为 false", async () => {
  const revisionFixture = structureFixtures.find(item => item.id === "revisions-all")
  assert.ok(revisionFixture)
  const parsedRevision = parseDocxBytes(revisionFixture.build())
  assert.equal(parsedRevision.coverage.revisions > 0, true)
  assert.equal(coverageComplete(parsedRevision.coverage), false)
  assert.equal(parsedRevision.paragraphs.map(item => item.text).join(""), revisionFixture.expected.text)

  const nested = await withBody("<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc>" + p("嵌套") + "</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>")
  const parsedNested = parseDocxBytes(nested)
  assert.equal(parsedNested.coverage.complex > 0, true)
  assert.throws(() => parseDocxBytes(new Uint8Array([1, 2, 3])))
  assert.throws(() => parseDocxBytes(Buffer.from("<xml/>")))
  await assert.rejects(parseDocument("synthetic.pdf"), { code: "REVIEW_DOCUMENT_INVALID" })
})

test("AC-24: 文本框样本解析正文不双计且 complete 为 false", () => {
  const textboxFixture = structureFixtures.find(item => item.id === "textbox-drawingml")
  assert.ok(textboxFixture)
  const parsed = parseDocxBytes(textboxFixture.build())
  assert.equal(parsed.paragraphs.map(item => item.text).join(""), "框内文字")
  assert.equal(parsed.coverage.textboxes, 1)
  assert.equal(coverageComplete(parsed.coverage), false)
})

test("AC-03：合成 DOCX 通过隔离解析入口，TXT 按行保持位置", async () => {
  const parsed = await parseDocument("tools/contract-review/fixtures/sample-contract.docx")
  assert.equal(parsed.complete, true)
  assert.ok(parsed.paragraphs.some(item => item.table?.row === 2))
  const paragraphs = paragraphsFromString("第一条\n内容一\n\n第二条\n内容二")
  assert.deepEqual(paragraphs.map(item => item.index), [0, 1, 2, 3])
  assert.equal(paragraphs[3].text, "内容二")
})
