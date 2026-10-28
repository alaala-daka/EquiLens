import assert from "node:assert/strict"
import { test } from "node:test"
import { validateDocxBytes } from "./docx"
import { structureFixtures } from "./structure-fixtures"

test("WD-13: 每个往返样本通过校验且清单与预期一致", () => {
  const ids = structureFixtures.map(item => item.id)
  assert.ok(ids.length >= 12)
  assert.equal(new Set(ids).size, ids.length)
  for (const fixture of structureFixtures) {
    const inspection = validateDocxBytes(fixture.build())
    assert.deepEqual(inspection.structures, fixture.expected.structures, fixture.id)
    assert.equal(inspection.text, fixture.expected.text, fixture.id)
  }
})

test("WD-13: 样本覆盖全部结构类别", () => {
  const totals = structureFixtures.reduce((sum, item) => ({
    images: sum.images + item.expected.structures.images,
    revisions: sum.revisions + item.expected.structures.revisions.insertions + item.expected.structures.revisions.deletions + item.expected.structures.revisions.moves + item.expected.structures.revisions.formatChanges,
    textboxes: sum.textboxes + item.expected.structures.textboxes,
    mergedCells: sum.mergedCells + item.expected.structures.mergedCells,
    notes: sum.notes + item.expected.structures.notes,
    comments: sum.comments + item.expected.structures.comments,
  }), { images: 0, revisions: 0, textboxes: 0, mergedCells: 0, notes: 0, comments: 0 })
  for (const [key, value] of Object.entries(totals)) assert.ok(value > 0, `${key} 缺少样本`)
})
