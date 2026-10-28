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
  result.coverage = []
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
  assert.match(view.summary, /问题 17 项/)
  assert.match(view.outcomeNotice, /初步问题.*6 类/)
  const markdown = toMarkdown(result)
  assert.match(markdown, /需要进一步确认/)
  assert.match(markdown, /未完成 2 项/)
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
  result.coverage = []
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

test("AC-03/21：19项检查的18个问题与1个无问题按互斥口径计数，网页和报告共用摘要", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.coverage = []
  result.findings = Array.from({ length: 19 }, (_, index) => finding({ ruleId: "COUNT-" + index,
    kind: index === 18 ? "未发现问题" : index === 0 ? "缺失条款" : "发现问题" }))
  const view = getReportView(result)
  assert.deepEqual([view.totalChecks, view.issueCount, view.noIssueCount, view.unfinishedCount, view.rejectedOrNotLocatedCount], [19, 18, 1, 0, 0])
  assert.equal(view.totalChecks, view.issueCount + view.noIssueCount + view.unfinishedCount + view.rejectedOrNotLocatedCount)
  assert.equal(view.groups.reduce((sum, group) => sum + group.findings.length, 0), view.issueCount)
  assert.match(view.summary, /共 19 项检查结论，其中问题 18 项、无问题 1 项、未完成 0 项/)
  assert.ok(toMarkdown(result).includes(view.summary))
})

test("AC-21：重复占位、旧拒绝和未定位按规则去重，未完成与拒绝互斥且不改原始结果", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.coverage = []
  result.errors = [{ code: "STOP", message: "未完成", ruleIds: ["ONLY-ERROR"] }]
  result.findings = [finding({ ruleId: "ISSUE" }), finding({ ruleId: "ISSUE" }),
    finding({ ruleId: "CLEAR", kind: "未发现问题" }),
    finding({ ruleId: "PENDING", kind: "待核实", pending: ["需补材料"] }),
    finding({ ruleId: "INVALID", kind: "待核实", placeholder: true }),
    finding({ ruleId: "ISSUE", kind: "待核实", placeholder: true })]
  result.rejected = [{ ruleId: "ISSUE", reason: "旧拒绝", detail: "已补齐" },
    { ruleId: "INVALID", reason: "引用错误", detail: "未补齐" },
    { ruleId: "INVALID", reason: "重复拒绝", detail: "保留明细" },
    { ruleId: "", reason: "模型格式错误", detail: "没有可识别的检查ID" }]
  result.notLocated = [{ ruleId: "INVALID", reason: "no-match", detail: "尚未定位" },
    { ruleId: "ISSUE", reason: "no-match", detail: "早期未定位记录" }]
  const original = toJson(result)
  const view = getReportView(result)
  assert.deepEqual([view.totalChecks, view.issueCount, view.noIssueCount, view.unfinishedCount, view.rejectedOrNotLocatedCount], [5, 1, 1, 2, 1])
  assert.equal(view.totalChecks, view.issueCount + view.noIssueCount + view.unfinishedCount + view.rejectedOrNotLocatedCount)
  assert.equal(view.groups[0].findings.length, 1)
  assert.equal(view.unfinished.filter(item => item.ruleId === "INVALID").length, 1)
  assert.ok(!view.unfinished.some(item => item.ruleId === "ISSUE" || !item.ruleId))
  assert.equal(toJson(result), original)
})

test("AC-21：空结果和全部被拒绝不显示无风险，计数总和始终一致", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.status = "failed"
  result.coverage = []
  result.findings = []
  const empty = getReportView(result)
  assert.equal(empty.totalChecks, 0)
  assert.match(empty.outcomeNotice, /尚不能确认无风险/)
  result.rejected = [{ ruleId: "BAD", reason: "无效引用", detail: "未补齐" }]
  result.notLocated = [{ ruleId: "BAD", reason: "no-match", detail: "未定位" }]
  const rejected = getReportView(result)
  assert.deepEqual([rejected.totalChecks, rejected.issueCount, rejected.noIssueCount, rejected.unfinishedCount, rejected.rejectedOrNotLocatedCount], [1, 0, 0, 0, 1])
  assert.equal(rejected.totalChecks, rejected.issueCount + rejected.noIssueCount + rejected.unfinishedCount + rejected.rejectedOrNotLocatedCount)
  assert.match(rejected.outcomeNotice, /尚不能确认无风险/)
})

test("AC-21：仅在检查进度里记录而无有效结论的规则计为未完成", async () => {
  const result = await reviewContract({ documentText: "付款条款。", pack: testPack(), model: validModel })
  result.status = "partial"
  result.findings = []
  result.coverage = [{ category: "付款条件与时间", status: "待核实", findingIds: ["COVERAGE-1", "COVERAGE-1"], note: "未完成" }]
  const view = getReportView(result)
  assert.deepEqual([view.totalChecks, view.issueCount, view.noIssueCount, view.unfinishedCount, view.rejectedOrNotLocatedCount], [1, 0, 0, 1, 0])
  assert.equal(view.unfinished[0].ruleId, "COVERAGE-1")
  assert.deepEqual(view.unfinishedGroups, [{ label: "付款", count: 1 }])
})
