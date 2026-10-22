import assert from "node:assert/strict"
import { test } from "node:test"
import { editorText, serializeWord } from "./serialize"

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

test("WD-08: edit snapshot text follows nested paragraphs and table cells", () => {
  assert.equal(editorText({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "合同 & 001" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "四十五日" }] }] }] }] },
    { type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "第二页" }] },
  ] }), "合同 & 001四十五日第二页")
})
