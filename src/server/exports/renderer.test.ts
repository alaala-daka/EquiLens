import assert from "node:assert/strict"
import { test } from "node:test"
import { unzipSync, strFromU8 } from "fflate"
import { renderDocx } from "./renderer"

test("fixed paragraphs produce deterministic DOCX and escape untrusted text", () => {
  const input = { paragraphs: ["人工正文 <script>&", "9007199254740993.01", "待补充"], metadata: ["AI 辅助生成", "待复核", "模板: v1", "渲染: paragraphs-v1"] }
  const first = renderDocx(input)
  assert.deepEqual(renderDocx(input), first)
  const xml = strFromU8(unzipSync(first)["word/document.xml"])
  assert.ok(xml.includes("人工正文 &lt;script&gt;&amp;"))
  for (const text of ["9007199254740993.01", "待补充", "待复核", "模板: v1"]) assert.ok(xml.includes(text))
})
