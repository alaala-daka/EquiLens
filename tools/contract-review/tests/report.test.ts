import assert from "node:assert/strict"
import { test } from "node:test"
import { compactText, groupIssues, isCompleteNoRisk, getReportView } from "../src/presentation"
import { reviewContract } from "../src/review"
import { toJson, toMarkdown } from "../src/report"
import { rule, testPack, validModel } from "./helpers"
import { CHECK_CATEGORIES, type Finding } from "../src/types"
import { sceneCatalog } from "../src/scenes"

const finding = (patch: Partial<Finding> = {}): Finding => ({
  ruleId: "T-001", category: "付款条件与时间", kind: "发现问题", risk: "付款期限不明。",
  severity: "一般关注", severityOrigin: "规则预设", quote: "付款条款。", paragraphIndex: 0,
  basis: ["S-1"], impact: "影响回款安排。", suggestion: "明确付款期限。", pending: [],
  reviewStatus: "待人工复核", ...patch,
})

test("AC-03/UI：类别预览保留所有独立规则，优先显示严重项，不改写原结果", () => {
  const items = [finding(), finding({ ruleId: "T-002", severity: "重大关注", paragraphIndex: 4 }),
    finding({ ruleId: "T-003", category: "工期" }), finding({ ruleId: "T-004", kind: "待核实" })]
  const before = structuredClone(items)
  const groups = groupIssues(items)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].findings.map(item => item.ruleId), ["T-002", "T-001"])
  assert.equal(groups.flatMap(item => item.findings).length, 3)
  assert.deepEqual(items, before)
})

test("AC-03/UI：长预览明确标记省略，不切断 Unicode 字符；短文本完整显示", () => {
  assert.equal(compactText("明确付款期限。", 80), "明确付款期限。")
  const text = "😀".repeat(90)
  assert.equal(compactText(text, 80), "😀".repeat(79) + "…")
  assert.equal(Array.from(compactText(text, 80)).length, 80)
})

test("AC-03/21：Markdown 默认精简，折叠保留长文、引文和依据，JSON 原样保留", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  const long = "原始详细问题".repeat(40)
  result.findings = [finding({ risk: long }), finding({ ruleId: "T-002", suggestion: "原始详细建议".repeat(40) })]
  result.status = "partial"
  result.errors.push({ code: "TEST_FAILURE", message: "合成执行错误", ruleIds: ["T-003"] })
  result.notLocated.push({ ruleId: "T-004", reason: "no-match", detail: "合成未完成" })
  result.rejected.push({ ruleId: "T-005", reason: "建议前后矛盾", detail: "合成拒绝原因" })
  const before = toJson(result)
  const markdown = toMarkdown(result)
  assert.match(markdown, /### 1\. 付款/)
  assert.match(markdown, /查看本类其余 1 项问题/)
  assert.match(markdown, /优先处理的问题/)
  assert.match(markdown, /<details>/)
  assert.ok(markdown.includes(long))
  assert.match(markdown, /原文：付款条款。/)
  assert.match(markdown, /依据：S-1/)
  assert.match(markdown, /合成执行错误/)
  assert.match(markdown, /合成未完成/)
  assert.match(markdown, /建议前后矛盾/)
  assert.equal(toJson(result), before)
})

test("AC-21：正常无风险与全部输出无效、未覆盖、未读全文分别处理", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  assert.equal(isCompleteNoRisk(result), true)
  assert.equal(isCompleteNoRisk({ ...result, status: "failed", findings: [] }), false)
  assert.equal(isCompleteNoRisk({ ...result, coverage: [] }), false)
  assert.equal(isCompleteNoRisk({ ...result, input: { ...result.input, complete: false } }), false)
  assert.equal(isCompleteNoRisk({ ...result, findings: result.findings.map(item => ({ ...item, pending: ["尚需核实"] })) }), false)
})

test("AC-21：删除唯一诉讼条款却声称保留诉讼，不能进入成功报告", async () => {
  const result = await reviewContract({
    documentText: "10.1 争议提交合成仲裁委员会仲裁。\n10.2 双方亦可直接向工程所在地人民法院提起诉讼。",
    pack: testPack([rule({ category: "争议约定" })]),
    model: async () => ({ text: JSON.stringify({ findings: [{
      ...finding(), quote: "10.1 争议提交合成仲裁委员会仲裁。", suggestion: "建议删除 10.2，保留诉讼并明确管辖。",
    }] }) }),
  })
  assert.equal(result.status, "failed")
  assert.equal(result.findings.length, 0)
  assert.ok(result.rejected.some(item => item.reason === "建议前后矛盾"))
  assert.ok(result.coverage.some(item => item.status === "待核实"))
})

test("AC-21: non-matched scene reports show evidence and missing input without a risk summary", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.status = "failed"
  result.findings = []
  result.sceneCandidates = sceneCatalog()
  for (const status of ["unsupported", "needs-confirmation"] as const) {
    result.sceneSelection = { status, sceneId: null, reason: "无法支持当前场景。", evidence: [{ paragraphIndex: 0, quote: "付款条款。" }], missingInfo: ["请补充合同关系。"] }
    const output = toMarkdown(result)
    assert.match(output, /无法支持当前场景/)
    assert.match(output, /请补充合同关系/)
    assert.match(output, /原文（第 1 段）/)
    assert.doesNotMatch(output, /风险摘要|未发现问题|问题与修改建议/)
  }
})

test("AC-03/21/UI: 17 issues, actual questions and two unfinished checks are distinct; saved JSON is unchanged", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.mode = "debug"
  result.status = "partial"
  result.findings = CHECK_CATEGORIES.flatMap((category, c) => Array.from({ length: c === 0 ? 4 : 3 }, (_, i) =>
    finding({ ruleId: `${c}-${i}`, category, pending: ["调试声明：依据来源状态为待核对，不构成正式法律意见。"] })))
  for (const item of result.findings.slice(-2)) Object.assign(item, { kind: "待核实", placeholder: true,
    pending: ["该必检项尚未取得有效结论，需要补读或重新审查。"] })
  result.findings[0].pending.unshift("请确认缺陷责任期。；")
  result.findings[1].pending.unshift("请确认缺陷责任期。")
  result.findings[2].pending.unshift("是否另有进度计划？")
  const before = toJson(result)
  const view = getReportView(result)
  assert.equal(view.issueCount, 17)
  assert.equal(view.groups.length, 6)
  assert.equal(view.unfinished.length, 2)
  assert.deepEqual(view.confirmations.map(item => item.text), ["请确认缺陷责任期。", "是否另有进度计划？"])
  assert.deepEqual(view.confirmations[0].ruleIds, ["0-0", "0-1"])
  assert.match(view.summary, /初步结果.*17 项问题.*6 类/)
  const markdown = toMarkdown(result)
  assert.match(markdown, /需要进一步确认/)
  assert.match(markdown, /2 项检查未形成有效结论/)
  assert.doesNotMatch(markdown, /19 项待核实|第 0 段/)
  assert.equal(toJson(result), before)
})

test("AC-21/UI: only whole known debug notices are grouped; substantive source doubts and published content stay visible", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.mode = "debug"
  const notices = [
    "调试声明：本结论所引依据来源状态为待核对，仅供联调，不构成正式法律意见。",
    "调试声明：所引依据来源状态为待核对，仅供联调，不构成正式法律意见。",
    "调试声明：依据来源状态为待核对，须回查示范文本官方原文，不构成正式法律意见。",
    "调试声明：依据来源为审查摘要示例且状态待核对，须回查示范文本原文，不构成正式法律意见。",
  ]
  const doubts = ["调试声明：依据与本项目的适用范围存在冲突。", "依据来源状态为待核对，但付款金额存在矛盾。",
    "依据来源状态并非待核对，仍需确认适用日期。", "该来源不适用于本项目。"]
  result.findings = [finding({ pending: [...notices, ...doubts] })]
  assert.deepEqual(getReportView(result).confirmations.map(item => item.text), doubts)
  result.mode = "published"
  assert.deepEqual(getReportView(result).confirmations.map(item => item.text), [...notices, ...doubts])
  result.mode = "debug"
  result.findings = [finding({ kind: "待核实", risk: "需确认来源的适用范围。", pending: notices })]
  assert.equal(getReportView(result).confirmations[0].text, "需确认来源的适用范围。")
})

test("AC-21/UI: audit incompleteness, doubts and input gaps remain visible without implying human approval", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.collaboration = { version: "multi-agent-v1", manifestSha256: "synthetic", phase: "auditing", primaryCompleted: true }
  assert.match(getReportView(result).auditNotice!, /AI 复查尚未完成/)
  assert.equal(getReportView(result).incomplete, true)
  assert.equal(isCompleteNoRisk(result), false)
  result.input.complete = false
  assert.match(getReportView(result).scopeNotes.join(""), /解析不完整/)
  result.input.complete = true
  result.collaboration.audit = { auditId: "synthetic", primaryReviewId: result.reviewId, inputSha256: result.input.textSha256,
    primarySha256: "synthetic", packSha256: "synthetic", status: "completed", reviewStatus: "待人工复核", mode: "debug",
    callsUsed: 0, startingCallsUsed: 0, elapsedMs: 0, usage: null, unreviewedRuleIds: [], rejected: [], errors: [],
    checks: [{ ruleId: "T-001", outcome: "需人工核对", issueTypes: ["依据支持"], note: "合成依据疑问", paragraphIndex: 0, quote: "付款条款。", basis: ["S-1"] }] }
  assert.match(getReportView(result).auditNotice!, /1 项需人工核对/)
  assert.equal(isCompleteNoRisk(result), false)
  assert.match(toMarkdown(result), /合成依据疑问/)
})

test("AC-21/UI: unfinished IDs are deduplicated and a later accepted answer is not counted as missing", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.findings = [finding(), finding({ ruleId: "T-002", kind: "待核实", placeholder: true, quote: "", paragraphIndex: -1,
    pending: ["未取得有效结论"] })]
  result.notLocated = [{ ruleId: "T-002", reason: "no-match", detail: "未定位" }]
  result.rejected = [{ ruleId: "T-001", reason: "旧回答无效", detail: "已重新提交" },
    { ruleId: "T-003", reason: "无效引用", detail: "未补齐" }]
  assert.deepEqual(getReportView(result).unfinished.map(item => item.ruleId), ["T-002", "T-003"])
  result.findings[1].placeholder = undefined
  result.findings[1].risk = "该必检项尚未取得有效结论，需要补读或重新审查。"
  assert.equal(getReportView(result).unfinished.length, 2)
})
