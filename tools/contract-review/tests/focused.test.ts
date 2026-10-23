import assert from "node:assert/strict"
import { test } from "node:test"
import { paragraphsFromString } from "../src/document"
import { toMarkdown } from "../src/report"
import { reviewContract, type AskModel } from "../src/review"
import { buildSegments } from "../src/segments"
import { rule, testPack, validModel } from "./helpers"

/** 20 条、约三万字的合成合同，用于验证全篇模式超限而定向模式可用。 */
function longContract() {
  const lines: string[] = []
  for (let index = 1; index <= 20; index++) {
    lines.push("第" + index + "条 条款" + index)
    lines.push((index === 7 ? "付款应当在验收后三十日内完成。" : "") + "条款" + index + "正文。" + "填充内容".repeat(120))
    lines.push("条款" + index + "补充。" + "备注内容".repeat(120))
  }
  return lines.join("\n")
}

test("AC-03：整篇超限时报错，定向取材后同一合同可以审查", async () => {
  const documentText = longContract()
  const paragraphs = paragraphsFromString(documentText)
  const exceeded = await reviewContract({ pack: testPack(), documentText, model: validModel })
  assert.equal(exceeded.status, "failed")
  assert.ok(exceeded.errors.some(item => item.code === "REVIEW_INPUT_TOO_LARGE"))

  const result = await reviewContract({
    pack: testPack(), documentText, model: async input => {
      const answer = JSON.parse((await validModel(input)).text)
      for (const item of answer.findings) item.kind = "发现问题"
      return { text: JSON.stringify(answer) }
    },
    segments: buildSegments(paragraphs),
  })
  assert.notEqual(result.status, "failed")
  assert.equal(result.errors.length, 0)
  assert.ok(result.findings.length > 0)
})

test("AC-03：定向模式只送相关条款，未命中段落不出现在提示中", async () => {
  const documentText = longContract()
  const paragraphs = paragraphsFromString(documentText)
  let prompt = ""
  const capture: AskModel = async input => {
    prompt = input.user
    return validModel(input)
  }
  await reviewContract({
    pack: testPack(), documentText, model: capture,
    segments: buildSegments(paragraphs),
  })
  assert.match(prompt, /# 全文目录/)
  assert.match(prompt, /第7条 条款7/)
  assert.match(prompt, /付款应当在验收后三十日内完成。/)
  assert.doesNotMatch(prompt, /条款1正文/)
  assert.ok(prompt.length < 12000, "定向提示应显著小于全文：" + prompt.length)
})

test("AC-03：定向模式仍逐字校验引文，编造句子不进入结论", async () => {
  const documentText = longContract()
  const paragraphs = paragraphsFromString(documentText)
  const model: AskModel = async input => {
    const base = JSON.parse((await validModel(input)).text) as { findings: Array<Record<string, unknown>> }
    for (const item of base.findings) { item.kind = "发现问题"; item.quote = "合同中并不存在的句子" }
    return { text: JSON.stringify(base) }
  }
  const result = await reviewContract({
    pack: testPack(), documentText, model,
    segments: buildSegments(paragraphs),
  })
  assert.equal(result.findings.length, 0)
  assert.equal(result.rejected.filter(item => item.reason === "引文校验失败").length, 6)
  assert.ok(result.rejected.every(item => item.reason === "引文校验失败" || item.reason === "缺少结论"))
  assert.equal(result.status, "failed")
})

test("AC-21：定向模式没有定位线索时仍送目录，不伪造已检查全文", async () => {
  const documentText = longContract()
  const paragraphs = paragraphsFromString(documentText)
  let prompt = ""
  const capture: AskModel = async input => {
    prompt = input.user
    return validModel(input)
  }
  const pack = testPack()
  for (const entry of pack.rules) entry.trigger = { keywords: ["不存在的词"] }
  const result = await reviewContract({
    pack, documentText, model: capture,
    segments: buildSegments(paragraphs),
  })
  assert.match(prompt, /# 全文目录/)
  assert.match(prompt, /未定位到相关条款/)
  assert.equal(result.notLocated.length, 6)
  assert.ok(result.notLocated.every(item => item.reason === "outline-only"))
  assert.match(toMarkdown(result), /未定位的检查项/)
})

test("AC-21：非必检规则没有命中线索时留痕，不能记作已检查", async () => {
  const pack = testPack([
    rule({ ruleId: "T-OPT", mandatory: false, trigger: { keywords: ["不存在的词"] } }),
  ])
  const result = await reviewContract({
    pack, documentText: "发包人应在验收合格后30日内付款。", model: validModel,
  })
  assert.equal(result.notLocated.length, 1)
  assert.equal(result.notLocated[0].ruleId, "T-OPT")
  assert.equal(result.notLocated[0].reason, "no-match")
  assert.notEqual(result.status, "success")
  assert.match(toMarkdown(result), /T-OPT：未执行/)
  assert.match(toMarkdown(result), /不计为已通过/)
})
