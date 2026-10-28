import assert from "node:assert/strict"
import { test } from "node:test"
import { countComparable, compareExport, emptyStructures, type DocxInspection, type ExportExpectation } from "./structures"

const structures = (patch: Partial<ReturnType<typeof emptyStructures>> = {}) => ({ ...emptyStructures(), ...patch })
// 正文场景：bodyStructures 与 structures 同值镜像。
const inspection = (text: string, patch: Partial<ReturnType<typeof emptyStructures>> = {}): DocxInspection =>
  ({ text, structures: structures(patch), bodyStructures: structures(patch) })

test("WD-14: 导出正文不一致时拒绝并给出既有文案", () => {
  const expected: ExportExpectation = { text: "改文", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  assert.throws(() => compareExport(inspection("原文"), expected), /导出正文与编辑内容不一致/)
})

test("WD-14: 导出结构少于快照时按类别拒绝", () => {
  const expected: ExportExpectation = { text: "正文", structures: { images: 2, revisions: 3, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  const actual = inspection("正文", { images: 1, revisions: { insertions: 1, deletions: 0, moves: 0, formatChanges: 0 } })
  assert.throws(() => compareExport(actual, expected), /图片、修订标记未保留/)
})

test("WD-14: 导出数量不减少时不误报（含用户删除内容）", () => {
  const expected: ExportExpectation = { text: "正文", structures: { images: 1, revisions: 1, comments: 1, notes: 1, textboxes: 1, mergedCells: 1 } }
  const actual = inspection("正文", { images: 2, revisions: { insertions: 1, deletions: 1, moves: 0, formatChanges: 0 }, comments: 1, notes: 1, textboxes: 1, mergedCells: 2 })
  assert.doesNotThrow(() => compareExport(actual, expected))
  const edited: ExportExpectation = { text: "正文", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  assert.doesNotThrow(() => compareExport(inspection("正文"), edited))
})

test("countComparable 汇总四类修订并保留其余类别", () => {
  const counts = countComparable(structures({ images: 2, comments: 1, notes: 3, textboxes: 4, mergedCells: 5, revisions: { insertions: 1, deletions: 2, moves: 3, formatChanges: 4 } }))
  assert.deepEqual(counts, { images: 2, revisions: 10, comments: 1, notes: 3, textboxes: 4, mergedCells: 5 })
})
