import assert from "node:assert/strict"
import { test } from "node:test"
import { compareExport, emptyStructures, type DocxInspection, type ExportExpectation } from "./structures"
import { editorStructures, editorText } from "./serialize"

test("WD-14: 快照派生的期望对象驱动对账", () => {
  // 修订以 mark 表示（superdoc@1.47.2 getJSON 校准模型，见 serialize.ts）。
  const snapshot = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "正文" }, { type: "image" }] },
    { type: "paragraph", content: [{ type: "text", text: "删除", marks: [{ type: "trackDelete", attrs: { id: "2" } }] }] },
  ] }
  const expected: ExportExpectation = { text: editorText(snapshot), structures: editorStructures(snapshot) }
  assert.equal(expected.text, "正文")
  assert.deepEqual(expected.structures, { images: 1, revisions: 1, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 })
  const body = () => ({ ...emptyStructures(), images: 1, revisions: { insertions: 0, deletions: 1, moves: 0, formatChanges: 0 } })
  const actual: DocxInspection = { text: "正文", structures: body(), bodyStructures: body() }
  assert.doesNotThrow(() => compareExport(actual, expected))
})
