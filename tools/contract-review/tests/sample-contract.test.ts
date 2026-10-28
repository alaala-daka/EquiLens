import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { parseDocxBytes, parseDocument, paragraphsFromString } from "../src/document"
import { routeScene } from "../src/agent/router"
import { sceneCatalog } from "../src/scenes"
import { sampleContractDocx } from "./sample-contract-fixture"

const fixture = "tools/contract-review/fixtures/sample-contract"

test("AC-03/21：完整 TXT 唯一生成 DOCX，段数、首尾及关键条款一致且可重复生成", async () => {
  const text = await readFile(fixture + ".txt", "utf8")
  const source = paragraphsFromString(text)
  const bytes = await readFile(fixture + ".docx")
  const actual = parseDocxBytes(bytes)
  assert.equal(source.length, 18)
  assert.equal(actual.length, source.length)
  assert.equal(actual[0].text, source[0].text)
  assert.equal(actual.at(-1)?.text, source.at(-1)?.text)
  for (const term of ["机电安装专业工程分包", "3860 万元", "365 日历天", "万分之五", "人民法院提起诉讼或"]) {
    const expected = source.find(item => item.text.includes(term))
    assert.ok(expected, `TXT 缺少关键条款：${term}`)
    assert.equal(actual[expected.index].text, expected.text)
  }
  assert.deepEqual(actual, source)
  assert.deepEqual(new Uint8Array(bytes), await sampleContractDocx(text))
  assert.deepEqual(await sampleContractDocx(text), await sampleContractDocx(text))
})

test("AC-03/21：网页 DOCX 样本通过隔离解析和一次自动路由，读取完整正文及范围证据", async () => {
  const parsed = await parseDocument(fixture + ".docx")
  const scope = parsed.paragraphs.find(item => item.text.includes("机电安装专业工程分包"))!
  let calls = 0
  const fetcher: typeof fetch = async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body))
    assert.deepEqual(request.tools.map((item: { function: { name: string } }) => item.function.name), ["selectScene"])
    const prompt = JSON.stringify(request.messages)
    for (const paragraph of parsed.paragraphs) assert.ok(prompt.includes(paragraph.text))
    return Response.json({ id: "sample-route", object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "sample-choice", type: "function", function: { name: "selectScene", arguments: JSON.stringify({
          status: "matched", sceneId: "mep-sub-2026", reason: "正文明确办公楼房建、机电安装和专业分包关系。",
          evidence: [{ paragraphIndex: scope.index, quote: scope.text }], missingInfo: [],
        }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })
  }
  const result = await routeScene({ paragraphs: parsed.paragraphs, complete: parsed.complete,
    context: { role: "专业分包人", region: "上海" }, candidates: sceneCatalog(), fetcher,
    env: { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" } })
  assert.equal(calls, 1)
  assert.equal(result.callsUsed, 1)
  assert.deepEqual(result.errors, [])
  assert.equal(result.selection?.sceneId, "mep-sub-2026")
  assert.equal(result.readParagraphIndexes.length, parsed.paragraphs.length)
})
