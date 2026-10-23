import assert from "node:assert/strict"
import { test } from "node:test"
import { ReviewError } from "../src/errors"
import { loadRulePack } from "../src/pack"
import { toJson, toMarkdown } from "../src/report"
import { reviewContract, type AskModel } from "../src/review"
import { answers, rule, testPack, validModel } from "./helpers"

const documentText = "发包人应在验收合格后30日内付款。"

test("AC-03：固定文字入口正常无风险成功，包含输入摘要及六类覆盖", async () => {
  const result = await reviewContract({ pack: testPack(), documentText, model: validModel })
  assert.equal(result.status, "success")
  assert.equal(result.coverage.length, 6)
  assert.equal(result.findings.length, 6)
  assert.equal(result.callsUsed, 1)
  assert.equal(result.input.textSha256.length, 64)
  assert.equal(JSON.parse(toJson(result)).schemaVersion, 1)
})

test("AC-21：全部回答无效或漏答，不能写成无风险", async () => {
  const result = await reviewContract({
    pack: testPack(), documentText,
    model: async () => ({ text: '{"findings":[{"ruleId":"T-001"}]}' }),
  })
  assert.equal(result.status, "failed")
  assert.ok(result.rejected.some(item => item.reason === "字段缺失"))
  assert.ok(result.rejected.some(item => item.reason === "缺少结论"))
  assert.ok(result.coverage.every(item => item.status === "待核实"))
  assert.doesNotMatch(toMarkdown(result), /必要检查已完成，未发现问题/)
})

test("AC-23：后续批次永久失败，前批结果保留且错误脱敏", async () => {
  let calls = 0
  const model: AskModel = async input => {
    if (++calls === 2) throw new ReviewError("AI_AUTH_ERROR")
    return validModel(input)
  }
  const result = await reviewContract({ pack: testPack(), documentText, model, batchSize: 2 })
  assert.equal(result.status, "partial")
  assert.equal(result.findings.length, 2)
  assert.equal(result.errors[0].code, "AI_AUTH_ERROR")
  assert.equal(result.rejected.filter(item => item.reason === "缺少结论").length, 4)
})

test("AC-23：多个批次与一次瞬时重试共用三次预算，发送前逐次预留", async () => {
  const reserved: number[] = []
  let calls = 0
  const model: AskModel = async input => {
    if (++calls === 1) throw new ReviewError("AI_RATE_LIMITED", 0)
    return validModel(input)
  }
  const result = await reviewContract({
    pack: testPack(), documentText, model, batchSize: 2,
    onBeforeCall: async ({ callNumber }) => { reserved.push(callNumber) },
  })
  assert.deepEqual(reserved, [1, 2, 3])
  assert.equal(calls, 3)
  assert.equal(result.callsUsed, 3)
  assert.equal(result.status, "partial")
  assert.ok(result.errors.some(item => item.code === "REVIEW_BUDGET_EXHAUSTED"))
})

test("AC-23：权限预留失败不发请求，恢复时不重置次数", async () => {
  let calls = 0
  const model: AskModel = async input => { calls++; return validModel(input) }
  const denied = await reviewContract({
    pack: testPack(), documentText, model,
    onBeforeCall: async () => { throw new Error("synthetic private detail") },
  })
  assert.equal(calls, 0)
  assert.equal(denied.errors[0].code, "REVIEW_RESERVATION_FAILED")
  assert.ok(!toJson(denied).includes("synthetic private detail"))
  const exhausted = await reviewContract({ pack: testPack(), documentText, model, callsUsed: 3 })
  assert.equal(calls, 0)
  assert.equal(exhausted.errors[0].code, "REVIEW_BUDGET_EXHAUSTED")
})

test("AC-23：取消或超时的模型不能继续后续批次", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const cancelled = await reviewContract({
    pack: testPack(), documentText, signal: controller.signal,
    model: async input => { calls++; return validModel(input) },
  })
  assert.equal(calls, 0)
  assert.equal(cancelled.status, "failed")
  assert.equal(cancelled.errors[0].code, "REVIEW_CANCELLED")
  const timed = await reviewContract({
    pack: testPack(), documentText, timeoutMs: 5,
    model: async () => new Promise(() => {}),
  })
  assert.equal(timed.errors[0].code, "REVIEW_TIMEOUT")
})

test("AC-03/21：默认拒绝草稿；调试标记进入全部输出且停用内容不使用", async () => {
  const pack = await loadRulePack("tools/contract-review/rules")
  // 用本地草稿包验证发布门槛，避免依赖内置规则包当前的发布状态。
  const draftPack = testPack(testPack().rules.map(item => ({ ...item, status: "待核对" as const })))
  let calls = 0
  const never: AskModel = async input => { calls++; return validModel(input) }
  const published = await reviewContract({ pack: draftPack, documentText, model: never })
  assert.equal(calls, 0)
  assert.equal(published.status, "failed")
  assert.equal(published.errors[0].code, "REVIEW_RULES_UNAVAILABLE")
  const debug = await reviewContract({ pack, documentText, model: never, mode: "debug" })
  // 缺少明确立场时不猜测，保留待核实，不调用模型。
  assert.equal(calls, 0)
  assert.equal(debug.mode, "debug")
  assert.ok(debug.findings.every(item => item.kind === "待核实"))
  assert.match(toMarkdown(debug), /开发调试/)
  assert.match(toJson(debug), /不形成正式法律结论/)
  pack.manifest.status = "已停用"
  const stopped = await reviewContract({ pack, documentText, model: never, mode: "debug" })
  assert.equal(stopped.findings.length, 0)
})

test("AC-21/24：不完整输入不能确认无问题，超限明确拒绝且不发送", async () => {
  const incomplete = await reviewContract({ pack: testPack(), documentText, model: validModel, complete: false })
  assert.equal(incomplete.status, "failed")
  assert.ok(incomplete.rejected.some(item => item.reason === "范围不完整"))
  let calls = 0
  const long = await reviewContract({
    pack: testPack(), documentText: "付款".repeat(1000), maxPromptChars: 1000,
    model: async input => { calls++; return validModel(input) },
  })
  assert.equal(calls, 0)
  assert.equal(long.errors[0].code, "REVIEW_INPUT_TOO_LARGE")
})

test("AC-21：没有定位线索也将必检项交给模型，允许返回缺失条款", async () => {
  const model: AskModel = async ({ user }) => ({
    text: JSON.stringify({ findings: answers(user).map(item => ({
      ...item, kind: "缺失条款", quote: "", paragraphIndex: -1,
    })) }),
  })
  const result = await reviewContract({ pack: testPack([rule()]), documentText: "合同只约定工期。", model })
  assert.equal(result.findings[0].kind, "缺失条款")
  assert.deepEqual(result.findings[0].checkedParagraphIndexes, [0])
})

test("AC-09：调用方随后修改输入对象，不改变本次原文校验范围", async () => {
  const paragraphs = [{ index: 0, text: documentText, inTable: false }]
  const pack = testPack()
  const model: AskModel = async input => {
    paragraphs[0].text = "调用方后续修改的其他版本"
    pack.rules.length = 0
    return validModel(input)
  }
  const result = await reviewContract({ pack, paragraphs, model })
  assert.equal(result.status, "success")
  assert.equal(result.paragraphs[0].text, documentText)
  assert.equal(result.findings.length, 6)
})
