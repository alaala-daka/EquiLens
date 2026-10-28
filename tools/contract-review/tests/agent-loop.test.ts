import assert from "node:assert/strict"
import { test } from "node:test"
import { reviewWithAgent } from "../src/agent/run"
import { testPack } from "./helpers"
import { findingsBatchSchema } from "../src/agent/schema"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
const skill = { id: "contract-review" as const, name: "合成", description: "测试", version: "test", instructions: "仅合成测试", sha256: "synthetic" }
const pack = testPack()
const options = { pack, skill, env, documentText: "付款条款。", maxPromptChars: 64000 }
const findings = pack.rules.map(rule => ({ ruleId: rule.ruleId, kind: "未发现问题", risk: "合成检查", severity: rule.severity, quote: "付款条款。", paragraphIndex: 0, basis: ["S-1"], impact: "", suggestion: "合成建议", pending: [] }))
const turns = [
  [{ name: "loadSkill", input: { skillId: "contract-review" } }],
  [{ name: "readParagraphs", input: { indexes: [0] } }, { name: "readSources", input: { sourceIds: ["S-1"] } }],
  [{ name: "submitFindings", input: { findings: findings.slice(0, 3) } }],
  [{ name: "submitFindings", input: { findings: findings.slice(3) } }],
  [],
]
function transport() {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    const turn = turns[calls++] ?? []
    return Response.json({ id: `synthetic-${calls}`, object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: turn.length ? "tool_calls" : "stop", message: { role: "assistant", content: turn.length ? null : "完成",
        ...(turn.length ? { tool_calls: turn.map((item, i) => ({ id: `call-${calls}-${i}`, type: "function", function: { name: item.name, arguments: JSON.stringify(item.input) } })) } : {}) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  }
  return { fetcher, count: () => calls }
}

test("AC-03/23: real SDK tool loop loads, reads, validates and reserves every request", async () => {
  const transportState = transport()
  const reservations: number[] = []
  const result = await reviewWithAgent({ ...options, fetcher: transportState.fetcher, maxCalls: 5,
    onBeforeCall: async ({ callNumber }) => { reservations.push(callNumber) } })
  assert.equal(result.status, "success")
  assert.equal(result.findings.length, 6)
  assert.equal(result.agent?.readParagraphIndexes.length, 1)
  assert.deepEqual(reservations, [1, 2, 3, 4])
  assert.equal(transportState.count(), 4)
})

test("AC-23: failed durable reservation prevents the SDK from sending the next request", async () => {
  const transportState = transport()
  const result = await reviewWithAgent({ ...options, fetcher: transportState.fetcher, maxCalls: 4,
    onBeforeCall: async ({ callNumber }) => { if (callNumber === 2) throw new Error("synthetic permission failure") } })
  assert.equal(transportState.count(), 1)
  assert.equal(result.status, "failed")
  assert.ok(result.errors.some(error => error.code === "REVIEW_RESERVATION_FAILED"))
})

test("AC-23: exhausted SDK budget leaves required checks unresolved", async () => {
  const transportState = transport()
  const result = await reviewWithAgent({ ...options, fetcher: transportState.fetcher, maxCalls: 2 })
  assert.equal(transportState.count(), 2)
  assert.equal(result.status, "failed")
  assert.equal(result.findings.filter(item => item.kind === "待核实").length, 6)
})

test("AC-23/24: submission schema bounds batches without dropping independent findings", () => {
  assert.equal(findingsBatchSchema.safeParse(findings.slice(0, 3)).success, true)
  assert.equal(findingsBatchSchema.safeParse(findings.slice(0, 4)).success, false)
  assert.equal(findingsBatchSchema.safeParse([]).success, false)
})

test("AC-23/24: truncation preserves earlier valid findings, records failure and counts the failed request", async () => {
  let calls = 0
  const base = transport()
  const exchanges: { call: number; finish: unknown }[] = []
  const result = await reviewWithAgent({ ...options, maxCalls: 6,
    fetcher: async (...args) => {
      calls++
      if (calls >= 4) return Response.json({ choices: [{ finish_reason: "length", message: {
        content: null, tool_calls: [{ id: "incomplete", type: "function", function: { name: "submitFindings", arguments: '{"findings":[' } }],
      } }], usage: { prompt_tokens: 50, completion_tokens: 8192, total_tokens: 8242 } })
      return base.fetcher(...args)
    },
    onModelExchange: async exchange => {
      const response = exchange.response as { choices: { finish_reason: unknown }[] }
      exchanges.push({ call: exchange.callNumber, finish: response.choices[0].finish_reason })
    },
  })
  assert.equal(calls, 5)
  assert.equal(result.callsUsed, 5)
  assert.equal(result.status, "partial")
  assert.equal(result.findings.filter(item => item.kind === "未发现问题").length, 3)
  assert.equal(result.findings.filter(item => item.kind === "待核实").length, 3)
  assert.equal(result.errors[0].code, "AI_OUTPUT_TRUNCATED")
  assert.deepEqual(exchanges.at(-1), { call: 5, finish: "length" })
  assert.equal(result.usage?.outputTokens, 30 + 8192 * 2)
})

test("AC-23/24: a single short repair succeeds in the original context without an extra summary request", async () => {
  let calls = 0
  const base = transport()
  const result = await reviewWithAgent({ ...options, maxCalls: 6,
    fetcher: async (...args) => {
      calls++
      if (calls <= 3) return base.fetcher(...args)
      if (calls === 4) return Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }],
        usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 } })
      const body = JSON.parse(String(args[1]?.body))
      assert.equal(body.max_tokens, 8192)
      if (calls === 5) assert.match(body.messages.at(-1).content, /只提交1条/)
      const batch = calls === 5 ? findings.slice(3, 4) : findings.slice(4)
      return Response.json({ id: `repair-${calls}`, object: "chat.completion", created: 1, model: "synthetic",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "submitFindings", arguments: JSON.stringify({ findings: batch }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
    },
  })
  assert.equal(result.status, "success")
  assert.equal(result.findings.length, 6)
  assert.equal(result.callsUsed, 6)
  assert.equal(calls, 6)
  assert.deepEqual(result.errors, [])
  assert.equal(result.usage?.outputTokens, 8192 + 50)
})
