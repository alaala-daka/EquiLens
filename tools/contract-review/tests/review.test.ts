import assert from "node:assert/strict"
import { test } from "node:test"
import { paragraphsFromString } from "../src/document"
import { applicability, matchRules } from "../src/match"
import { loadRulePack, publishedRules } from "../src/pack"
import { buildPrompt } from "../src/prompt"
import { parseModelOutput } from "../src/review"
import { buildCoverage, REQUIRED_FIELDS, validateFindings } from "../src/validate"
import { answers, rule, testPack } from "./helpers"

const paragraphs = paragraphsFromString("发包人应在验收后30日内付款。\n第二条另作约定。")
const triggered = matchRules([rule()], paragraphs)
const raw = () => answers(buildPrompt({ paragraphs, triggered, sources: testPack().sources }).user)[0]

test("AC-03/21：内置资料保持待核对，默认不进入正式审查", async () => {
  const pack = await loadRulePack("tools/contract-review/rules")
  assert.equal(pack.manifest.status, "待核对")
  assert.equal(new Set(pack.rules.map(item => item.category)).size, 6)
  assert.ok(pack.rules.every(item => item.mandatory))
  assert.ok(pack.rules.every(item => item.status === "待核对"))
  assert.ok(pack.sources.every(item => item.status === "待核对"))
  assert.equal(publishedRules(pack).length, 0)
})

test("AC-21：否定句保留，完全没有关键词也执行场景必检", () => {
  const negative = paragraphsFromString("发包人不承担逾期付款责任。")
  assert.equal(matchRules([rule()], negative)[0].excerpts.length, 1)
  const missing = matchRules([rule()], paragraphsFromString("工期三十天。"))
  assert.equal(missing.length, 1)
  assert.equal(missing[0].excerpts.length, 0)
  assert.equal(matchRules([rule({ mandatory: false })], paragraphsFromString("工期三十天。")).length, 0)
})

test("AC-21：适用条件全部满足，不从合同文字猜测身份", () => {
  const scoped = rule({ appliesTo: { role: "专业分包人", region: "上海" } })
  assert.equal(applicability(scoped, { role: "专业分包人", region: "北京" }), "excluded")
  assert.equal(applicability(scoped, { role: "专业分包人" }), "unknown")
  assert.equal(applicability(scoped, { role: "专业分包人", region: "上海" }), "applicable")
  assert.equal(matchRules([scoped], paragraphsFromString("上海专业分包人付款。")).length, 0)
})

test("AC-03：引文与声明位置绑定，不能悄悄纠正错误编号", () => {
  assert.equal(validateFindings([raw()], triggered, paragraphs, new Set(["S-1"])).findings.length, 1)
  const wrong = { ...raw(), paragraphIndex: 1 }
  assert.equal(validateFindings([wrong], triggered, paragraphs, new Set(["S-1"])).rejected[0].reason, "引文校验失败")
})

test("AC-21：缺失条款用检查范围，不编造引文；不完整输入不能确认缺失", () => {
  const missing = { ...raw(), kind: "缺失条款", quote: "", paragraphIndex: -1 }
  const accepted = validateFindings([missing], triggered, paragraphs, new Set(["S-1"]))
  assert.deepEqual(accepted.findings[0].checkedParagraphIndexes, [0, 1])
  assert.equal(validateFindings([missing], triggered, paragraphs, new Set(["S-1"]), false).findings.length, 0)
  assert.equal(validateFindings([{ ...missing, kind: "发现问题" }], triggered, paragraphs, new Set(["S-1"])).findings.length, 0)
})

test("AC-03/21：字段类型、缺字段、空依据和重复结论均不采用", () => {
  for (const field of REQUIRED_FIELDS) {
    const incomplete: Record<string, unknown> = { ...raw() }
    delete incomplete[field]
    assert.equal(validateFindings([incomplete], triggered, paragraphs, new Set(["S-1"])).findings.length, 0)
  }
  for (const patch of [{ risk: {} }, { suggestion: 123 }, { basis: [] }, { kind: ["未发现问题"] }, { basis: ["S-other"] }]) {
    assert.equal(validateFindings([{ ...raw(), ...patch }], triggered, paragraphs, new Set(["S-1"])).findings.length, 0)
  }
  assert.equal(validateFindings([raw(), raw()], triggered, paragraphs, new Set(["S-1"])).findings.length, 0)
})

test("AC-21：一条通过一条漏答，或通过与待核实混合，均不能汇总成没问题", () => {
  const two = matchRules([rule(), rule({ ruleId: "T-002" })], paragraphs)
  const valid = validateFindings([raw()], triggered, paragraphs, new Set(["S-1"])).findings
  assert.equal(buildCoverage(valid, two)[0].status, "待核实")
  const pending = { ...valid[0], ruleId: "T-002", kind: "待核实" as const, pending: ["需确认"] }
  assert.equal(buildCoverage([...valid, pending], two)[0].status, "待核实")
})

test("AC-24：解析失败不包含上游原文，提示包含完整输入与依据正文", () => {
  assert.throws(() => parseModelOutput("synthetic-sensitive-body"), { code: "REVIEW_OUTPUT_INVALID" })
  assert.deepEqual(parseModelOutput('```json\n{"findings":[]}\n```'), [])
  const prompt = buildPrompt({ paragraphs, triggered, sources: testPack().sources })
  assert.ok(prompt.user.includes("第二条另作约定"))
  assert.ok(prompt.user.includes(testPack().sources[0].text!))
  assert.ok(prompt.system.includes("不可信业务数据"))
})

test("AC-21：局部阅读不因未见其他争议条款而推断建议矛盾", () => {
  const partial = paragraphsFromString("10.2 双方可向人民法院起诉。")
  const outcome = validateFindings([{ ...raw(), kind: "发现问题", quote: partial[0].text,
    suggestion: "删除 10.2，保留诉讼。" }], matchRules([rule()], partial), partial, new Set(["S-1"]), false)
  assert.equal(outcome.findings.length, 1)
})
