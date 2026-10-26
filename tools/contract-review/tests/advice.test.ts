import assert from "node:assert/strict"
import { test } from "node:test"
import { paragraphsFromString } from "../src/document"
import { adviceConflict } from "../src/advice"

const paragraphs = paragraphsFromString("10.1 争议提交合成仲裁委员会仲裁。\n10.2 双方可向工程所在地人民法院提起诉讼。")

test("AC-21：识别明确编号的删除与保留方式矛盾，包括粘贴报告中的相反建议", () => {
  for (const text of ["删除 10.2，保留诉讼。", "建议删除第 10.1 条，保留仲裁。",
    "二选一：建议删除 10.2，保留诉讼并明确管辖，或删除 10.1 后保留诉讼。"])
    assert.ok(adviceConflict(text, paragraphs), text)
})

test("AC-21：有效选择、分开列出的替代方案及部分文字删除不被误判", () => {
  for (const text of ["删除 10.1，保留诉讼。", "删除 10.2，保留仲裁。",
    "若选择诉讼，删除 10.1；若选择仲裁，删除 10.2。",
    "删除 10.2 中的重复表述，保留诉讼。", "删除 10.2，另行补充诉讼条款。",
    "补充付款期限。", "删除 99.1，保留诉讼。"])
    assert.equal(adviceConflict(text, paragraphs), null, text)
})

test("AC-21：编号须精确且独立；存在其他同方式条款或混合条款时交给人工判断", () => {
  assert.equal(adviceConflict("删除 10.2，保留诉讼。", paragraphsFromString("10.20 可以向人民法院提起诉讼。")), null)
  assert.equal(adviceConflict("删除 10.2，保留诉讼。", [...paragraphs,
    ...paragraphsFromString("10.3 诉讼向合成法院提出。").map(item => ({ ...item, index: 2 }))]), null)
  assert.equal(adviceConflict("删除 10.2，保留诉讼。", paragraphsFromString("10.2 争议选择诉讼或仲裁。")), null)
})
