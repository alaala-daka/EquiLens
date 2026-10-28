import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createWordSerializer, editorParagraphs, editorStructures, editorText, serializeWord, WordExportTimeout } from "./serialize"

// 校准样本取自 superdoc@1.47.2 引擎 getJSON() 捕获（.superpowers/previews/word-structures/engine/），
// 精简样式后保留 type/content/attrs/marks 骨架，文字为合成内容。
const sample = (id: string) => JSON.parse(readFileSync(new URL(`./calibration/${id}.json`, import.meta.url), "utf8"))

test("WD-06/08: an engine exception must reject fallback original bytes", async () => {
  let errors = 0
  const original = new Blob(["original"])
  await assert.rejects(serializeWord(async () => { errors++; return original }, () => errors), /导出失败/)
})

test("WD-08: successful serialization returns the exact edited Blob", async () => {
  const edited = new Blob(["edited"])
  assert.equal(await serializeWord(async () => edited, () => 0), edited)
  await assert.rejects(serializeWord(async () => new Blob(), () => 0), /导出失败/)
})

test("WD-06: a stalled export rejects within its deadline", async () => {
  await assert.rejects(serializeWord(() => new Promise(() => {}), () => 0, 5), /超时/)
})

for (const outcome of ["resolve", "reject"] as const) {
  test(`WD-06/07: timed-out ${outcome} keeps the instance locked until the exporter settles`, async () => {
    let resolve!: (value: Blob) => void
    let reject!: (error: Error) => void
    const deferred = new Promise<Blob>((yes, no) => { resolve = yes; reject = no })
    const serialize = createWordSerializer(() => 0, 5)
    let settled = false
    let exports = 0
    const first = serialize(async () => {
      exports++
      try { return await deferred } finally { settled = true }
    })
    await assert.rejects(first, WordExportTimeout)
    assert.equal(settled, false)
    await assert.rejects(serialize(async () => { exports++; return new Blob(["second"]) }), /仍在处理/)
    assert.equal(exports, 1)
    if (outcome === "resolve") resolve(new Blob(["late"]))
    else reject(new Error("late vendor failure"))
    await new Promise((done) => setImmediate(done))
    assert.equal(settled, true)
    assert.equal((await serialize(async () => new Blob(["next"]))).size, 4)
  })
}

test("WD-07: late settlement is confined to its own instance lock", async () => {
  let resolve!: (value: Blob) => void
  const old = createWordSerializer(() => 0, 5)
  const current = createWordSerializer(() => 0, 100)
  await assert.rejects(old(() => new Promise<Blob>((yes) => { resolve = yes })), WordExportTimeout)
  let settleCurrent!: (value: Blob) => void
  const pending = current(() => new Promise<Blob>((yes) => { settleCurrent = yes }))
  resolve(new Blob(["old"]))
  await new Promise((done) => setImmediate(done))
  await assert.rejects(current(async () => new Blob(["overlap"])), /仍在处理/)
  settleCurrent(new Blob(["current"]))
  assert.equal(await (await pending).text(), "current")
})

test("WD-08: edit snapshot text follows nested paragraphs and table cells", () => {
  assert.equal(editorText({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "合同 & 001" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "四十五日" }] }] }] }] },
    { type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "第二页" }] },
  ] }), "合同 & 001四十五日第二页")
})

test("clean copy extraction preserves top-level paragraph boundaries", () => {
  const json = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
    { type: "paragraph", content: [{ type: "text", text: "含 " }, { type: "text", text: "& < >" }] },
    { type: "paragraph" },
    { type: "heading", content: [{ type: "text", text: "标题" }] },
  ] }
  assert.deepEqual(editorParagraphs(json), ["第一段", "含 & < >", "", "标题"])
  assert.deepEqual(editorParagraphs(null), [])
  assert.deepEqual(editorParagraphs({ type: "doc" }), [])
})
test("校准: 修订样本正文不含删除文字、结构计数与清单一致", () => {
  const json = sample("revisions-all")
  assert.equal(editorText(json).includes("删除"), false)
  assert.equal(editorText(json).includes("新增"), true)
  assert.equal(editorStructures(json).revisions, 5)
})

test("校准: 文本框、脚注、批注、合并单元格计数", () => {
  assert.equal(editorStructures(sample("textbox-drawingml")).textboxes, 1)
  assert.equal(editorText(sample("textbox-drawingml")), "框内文字")
  assert.equal(editorStructures(sample("footnotes")).notes, 1)
  assert.equal(editorStructures(sample("comments")).comments, 1)
  assert.equal(editorStructures(sample("table-merge")).mergedCells, 3)
})

test("校准: 修订正文保留插入与移入文字、排除删除与移出文字", () => {
  assert.equal(editorText(sample("revisions-all")), "一、合同工期：新增二、质量标准：三、价款结算方式见附件四、移入文字")
})

test("校准: VML 文本框按 passthrough 原始 XML 提取正文并计数", () => {
  assert.equal(editorText(sample("textbox-vml")), "框内文字（VML）")
  const vml = editorStructures(sample("textbox-vml"))
  assert.equal(vml.images, 1)
  assert.equal(vml.textboxes, 1)
})

test("校准: 页码域无缓存不占正文、总页数域取缓存文本", () => {
  assert.equal(editorText(sample("field-page")), "页码示例：第  页，共 1页。")
})

test("校准: 批注文字保留在正文、DrawingML 文本框计图片与文本框", () => {
  assert.equal(editorText(sample("comments")), "第一条付款期限为三十日。")
  assert.equal(editorText(sample("footnotes")), "工程价款以结算单为准。")
  assert.equal(editorText(sample("table-merge")), "分包范围机电安装工程合同价款暂定伍佰万元工期一百八十日")
  const drawing = editorStructures(sample("textbox-drawingml"))
  assert.equal(drawing.images, 1)
})
