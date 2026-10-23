import assert from "node:assert/strict"
import { test } from "node:test"
import { buildOutline, buildSegments, collectParagraphs, isHeading } from "../src/segments"
import type { Paragraph } from "../src/types"

function paragraphs(texts: string[]): Paragraph[] {
  return texts.map((text, index) => ({ index, text, inTable: false }))
}

test("AC-03：按条款编号切块，段落不重复不遗漏", () => {
  const input = paragraphs([
    "建设工程专业分包合同",
    "发包人：甲方",
    "第1条 工程概况",
    "工程名称：某项目",
    "第2条 承包范围",
    "包括机电安装",
    "不含消防",
    "第3条 付款方式",
    "按月计量支付",
  ])
  const segments = buildSegments(input)
  assert.equal(segments.length, 4)
  const covered = segments.flatMap(segment => segment.indexes)
  assert.deepEqual(covered, input.map(item => item.index))
  assert.equal(segments[0].title, "建设工程专业分包合同")
  assert.equal(segments[1].title, "第1条 工程概况")
  assert.equal(segments[3].title, "第3条 付款方式")
  assert.match(segments[3].text, /^\[7\] 第3条 付款方式\n\[8\] 按月计量支付$/)
})

test("AC-24：无编号文档按段落边界切块，段落内部不被切断", () => {
  const input = paragraphs(Array.from({ length: 12 }, (_, index) => "第" + index + "段内容".repeat(60)))
  const segments = buildSegments(input, 1000)
  assert.ok(segments.length > 1)
  const covered = segments.flatMap(segment => segment.indexes)
  assert.deepEqual(covered, input.map(item => item.index))
  for (const segment of segments) {
    for (const index of segment.indexes) {
      assert.match(segment.text, new RegExp("\\[" + index + "\\] " + "第" + index + "段内容".repeat(60)))
    }
  }
})

test("AC-03：表格段落进入切块且保留编号", () => {
  const input: Paragraph[] = [
    { index: 0, text: "第1条 计价", inTable: false },
    { index: 1, text: "综合单价", inTable: true, table: { index: 1, row: 1, column: 1 } },
    { index: 2, text: "数量", inTable: true, table: { index: 1, row: 1, column: 2 } },
  ]
  const segments = buildSegments(input)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].indexes, [0, 1, 2])
  assert.match(segments[0].text, /\[1\] 综合单价/)
})

test("AC-03：目录列出全部块，可供模型判断全文结构", () => {
  const segments = buildSegments(paragraphs(["第1条 工程概况", "内容", "第2条 工期", "内容"]))
  assert.equal(buildOutline(segments), "第1条 工程概况（段 0–1）\n第2条 工期（段 2–3）")
})

test("AC-24：空输入返回空块，标题识别不误判正文", () => {
  assert.deepEqual(buildSegments([]), [])
  assert.equal(isHeading("第7条 付款"), true)
  assert.equal(isHeading("一、工程概况"), true)
  assert.equal(isHeading("（二）付款方式"), true)
  assert.equal(isHeading("1.1 计价"), true)
  assert.equal(isHeading("按照第一条约定支付"), false)
})

test("AC-09：按编号取材不改动原文顺序", () => {
  const input = paragraphs(["甲", "乙", "丙", "丁"])
  assert.deepEqual(collectParagraphs(input, [3, 1]).map(item => item.text), ["乙", "丁"])
})
