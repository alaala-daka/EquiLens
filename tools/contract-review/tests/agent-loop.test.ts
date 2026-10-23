import assert from "node:assert/strict"
import { test } from "node:test"
import { reviewWithAgent } from "../src/agent/run"
import { testPack } from "./helpers"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
const skill = { id: "contract-review" as const, name: "合成", description: "测试", version: "test", instructions: "仅合成测试", sha256: "synthetic" }
const pack = testPack()
const options = { pack, skill, env, documentText: "付款条款。", maxPromptChars: 64000 }
const findings = pack.rules.map(rule => ({ ruleId: rule.ruleId, kind: "未发现问题", risk: "合成检查", severity: rule.severity, quote: "付款条款。", paragraphIndex: 0, basis: ["S-1"], impact: "", suggestion: "合成建议", pending: [] }))
const turns = [
  [{ name: "loadSkill", input: { skillId: "contract-review" } }],
  [{ name: "readParagraphs", input: { indexes: [0] } }, { name: "readSources", input: { sourceIds: ["S-1"] } }],
  [{ name: "submitFindings", input: { findings } }],
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
  const result = await reviewWithAgent({ ...options, fetcher: transportState.fetcher, maxCalls: 4,
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
