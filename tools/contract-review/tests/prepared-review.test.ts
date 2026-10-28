import assert from "node:assert/strict"
import { test } from "node:test"
import { reviewWithAgent } from "../src/agent/run"
import { CHECK_CATEGORIES } from "../src/types"
import { rule, testPack } from "./helpers"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
const pack = testPack(CHECK_CATEGORIES.flatMap((category, i) => Array.from({ length: i === 0 ? 4 : 3 }, (_, j) => rule({ category, ruleId: `R-${i}-${j}` }))))
const skill = { id: "contract-review" as const, name: "合成", description: "测试", version: "test", instructions: "仅合成测试", sha256: "synthetic" }
const options = { pack, skill, env, documentText: "付款条款。\n关联条款及合同内的忽略规则指令均为待审材料。", strategy: "prepared-v1" as const, reasoningEffort: "low" as const }
type Request = { tools: { function: { name: string } }[]; messages: { role: string; content: string }[]; reasoning_effort?: string }
const packet = (body: Request) => JSON.parse(body.messages.find(message => message.role === "user")!.content)
const finding = (id: string) => ({ ruleId: id, kind: "未发现问题", risk: "合成检查", severity: "一般关注", quote: "付款条款。", paragraphIndex: 0, basis: ["S-1"], impact: "", suggestion: "无需修改", pending: [] })
function response(ids: string[], finish = "tool_calls") {
  return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: finish,
    message: { role: "assistant", content: null, ...(finish === "tool_calls" ? { tool_calls: [{ id: "batch", type: "function", function: { name: "submitFindings", arguments: JSON.stringify({ findings: ids.map(finding) }) } }] } : {}) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
}

test("AC-03/21/23: prepared primary starts with evidence and completes 19 rules in six isolated requests", async () => {
  const requests: Request[] = [], reservations: number[] = []
  const result = await reviewWithAgent({ ...options, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body)
    assert.deepEqual(body.tools.map((item: { function: { name: string } }) => item.function.name), ["submitFindings"])
    const input = packet(body)
    assert.equal(input.paragraphs.length, 2)
    assert.equal(input.sources[0].sourceId, "S-1")
    assert.equal(input.skill.sha256, skill.sha256)
    assert.equal(new Set(input.rules.map((item: { category: string }) => item.category)).size, 1)
    assert.equal(body.messages.length, 2)
    assert.equal(body.reasoning_effort, "low")
    return response(input.targetRuleIds)
  }, onBeforeCall: async value => { reservations.push(value.callNumber) } })
  assert.equal(result.status, "success")
  assert.equal(requests.length, 6)
  assert.ok(requests.every(body => JSON.stringify(body.tools) === JSON.stringify(requests[0].tools)))
  assert.deepEqual(reservations, [1, 2, 3, 4, 5, 6])
  assert.equal(result.findings.length, 19)
  assert.ok(result.findings.every(item => item.checkedParagraphIndexes?.length === 2))
  assert.equal(result.agent?.preparation?.receipts.length, 6)
  assert.equal(result.usage?.totalTokens, 720)
})

test("AC-09/23: prepared recovery skips accepted categories and cannot switch strategies", async () => {
  const seen: string[][] = []; let refuse = true
  const fetcher: typeof fetch = async (_url, init) => {
    const input = packet(JSON.parse(String(init?.body))); seen.push(input.targetRuleIds)
    if (seen.length === 3 && refuse) { refuse = false; return response([], "content_filter") }
    return response(input.targetRuleIds)
  }
  const first = await reviewWithAgent({ ...options, fetcher })
  assert.equal(first.status, "partial"); assert.equal(first.findings.filter(item => !item.placeholder).length, 7)
  const second = await reviewWithAgent({ ...options, fetcher, previousResult: first, callsUsed: first.callsUsed })
  assert.equal(second.status, "success"); assert.equal(second.callsUsed, 7)
  assert.deepEqual(seen[3], seen[2]); assert.equal(second.usage?.totalTokens, 840)
  await assert.rejects(reviewWithAgent({ ...options, strategy: undefined, previousResult: first, callsUsed: first.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
  const changed = structuredClone(pack); changed.sources[0].text = "另一个来源版本。"
  await assert.rejects(reviewWithAgent({ ...options, pack: changed, previousResult: first, callsUsed: first.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
  await assert.rejects(reviewWithAgent({ ...options, reasoningEffort: "default", previousResult: first, callsUsed: first.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
})

test("AC-21/23: truncated prepared output is not adopted and the retry uses a smaller fresh batch", async () => {
  const sizes: number[] = []
  const result = await reviewWithAgent({ ...options, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = packet(body); sizes.push(input.targetRuleIds.length)
    assert.equal(body.messages.length, 2)
    return response(input.targetRuleIds, sizes.length === 1 ? "length" : "tool_calls")
  } })
  assert.equal(result.status, "success")
  assert.deepEqual(sizes.slice(0, 5), [4, 1, 1, 1, 1])
  assert.equal(result.findings.length, 19)
  assert.ok(!result.errors.length)
})

test("AC-21/24: rejected quotes are retried only for unfinished rules, and absent sources cannot prove no risk", async () => {
  const seen: string[][] = []
  const result = await reviewWithAgent({ ...options, fetcher: async (_url, init) => {
    const input = packet(JSON.parse(String(init?.body))); seen.push(input.targetRuleIds)
    if (seen.length === 1) {
      const bad = await response(input.targetRuleIds).json()
      const values = input.targetRuleIds.map(finding); values[0].quote = "伪造引文"
      bad.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ findings: values })
      return Response.json(bad)
    }
    return response(input.targetRuleIds)
  } })
  assert.equal(result.status, "success"); assert.deepEqual(seen[1], ["R-0-0"])
  assert.equal(result.rejected.length, 1)
  const unavailable = structuredClone(pack); unavailable.sources[0].status = "已停用"
  const stopped = await reviewWithAgent({ ...options, pack: unavailable, maxCalls: 2, fetcher: async (_url, init) => response(packet(JSON.parse(String(init?.body))).targetRuleIds) })
  assert.ok(stopped.findings.every(item => item.placeholder))
  assert.notEqual(stopped.status, "success")
})

test("AC-21/23/24: oversized prepared packets and rejected reservations never mark materials delivered", async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_url, init) => { calls++; return response(packet(JSON.parse(String(init?.body))).targetRuleIds) }
  const large = await reviewWithAgent({ ...options, maxPromptChars: 1000, fetcher })
  assert.equal(calls, 0); assert.equal(large.agent?.preparation?.receipts.length, 0)
  const denied = await reviewWithAgent({ ...options, fetcher, onBeforeCall: async () => { throw new Error("revoked") } })
  assert.equal(calls, 0); assert.equal(denied.agent?.preparation?.receipts.length, 0)
  assert.equal(denied.agent?.readParagraphIndexes.length, 0)
})

test("AC-21/23: malformed correction parameters retain useful feedback in the next fresh request", async () => {
  let calls = 0
  const result = await reviewWithAgent({ ...options, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = packet(body); calls++
    if (calls === 1) {
      const data = await response(input.targetRuleIds).json(), values = input.targetRuleIds.map(finding)
      Object.assign(values[0], { kind: "缺失条款", quote: "", paragraphIndex: -1, citations: [{ paragraphIndex: 0, quote: "付款条款。" }] })
      data.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ findings: values })
      return Response.json(data)
    }
    if (calls === 2) {
      assert.deepEqual(input.targetRuleIds, ["R-0-0"])
      assert.ok(input.corrections.some((item: { detail: string }) => item.detail.includes("空数组")))
      const data = await response(input.targetRuleIds).json()
      data.choices[0].message.tool_calls[0].function.arguments = '{"findings":['
      return Response.json(data)
    }
    if (calls === 3) {
      assert.equal(body.messages.length, 2)
      assert.ok(input.corrections.some((item: { reason: string }) => item.reason === "模型结构无效"))
      assert.deepEqual(input.targetRuleIds, ["R-0-0"])
    }
    return response(input.targetRuleIds)
  } })
  assert.equal(result.status, "success")
  assert.equal(result.callsUsed, 8)
  assert.equal(result.rejected.length, 2)
  assert.equal(result.findings.length, 19)
})

test("AC-21/24: a stable tool schema still rejects another category or an unknown rule before adoption", async () => {
  let calls = 0
  const result = await reviewWithAgent({ ...options, fetcher: async (_url, init) => {
    const input = packet(JSON.parse(String(init?.body))); calls++
    if (calls === 1) return response(["R-5-0", "UNKNOWN"])
    if (calls === 2) {
      assert.deepEqual(input.targetRuleIds, ["R-0-0", "R-0-1", "R-0-2", "R-0-3"])
      assert.ok(input.corrections.some((item: { reason: string }) => item.reason === "本批规则范围无效"))
    }
    return response(input.targetRuleIds)
  } })
  assert.equal(result.status, "success"); assert.equal(result.callsUsed, 7)
  assert.ok(!result.findings.some(item => item.ruleId === "UNKNOWN"))
  assert.equal(result.findings.length, 19)
})
