import assert from "node:assert/strict"
import { test } from "node:test"
import { ToolLoopAgent, stepCountIs, tool } from "ai"
import { z } from "zod"
import { createAgentModel } from "../src/agent/model"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-secret" }
const call = (args: unknown = '{"amount":"120.00"}') => ({ id: "synthetic-call", type: "function", function: { name: "submitCheck", arguments: args } })
const envelope = (toolCalls: unknown, finishReason = "tool_calls") => ({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: null, tool_calls: toolCalls } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })

function harness(response: unknown) {
  const events: string[] = []
  let requests = 0, executed = 0
  const { model } = createAgentModel({ env, signal: new AbortController().signal, maxPromptChars: 64000, requestTimeoutMs: 5000, lengthRepair: false,
    beforeRequest: async () => { events.push("reserved") }, afterResponse: () => events.push("response-accepted"),
    onExchange: async () => { events.push("exchange-saved") }, onFailure: failure => events.push(failure.code),
    fetcher: async (_url, init) => {
      requests++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, env.AI_MODEL)
      assert.notEqual(body.stream, true)
      assert.equal(body.tools[0].function.name, "submitCheck")
      assert.notEqual(body.tool_choice?.type, "function", "不要强制命名工具，当前端点 thinking 模式不支持")
      return Response.json(response)
    },
  })
  const agent = new ToolLoopAgent({ model, maxRetries: 0, stopWhen: stepCountIs(1), maxOutputTokens: 256,
    tools: { submitCheck: tool({ description: "核对合成金额", inputSchema: z.object({ amount: z.literal("120.00") }).strict(),
      execute: async () => { executed++; return { accepted: true } } }) },
  })
  return { run: () => agent.generate({ prompt: "仅核对合成材料：金额120.00元。" }), events,
    requests: () => requests, executed: () => executed }
}

test("MG-05/AC-23: actual ToolLoopAgent accepts valid tool_calls and records exactly one reservation", async () => {
  const state = harness(envelope([call()]))
  const result = await state.run()
  assert.equal(state.requests(), 1)
  assert.equal(state.executed(), 1)
  assert.equal(result.toolCalls.length, 1)
  assert.ok(!result.toolCalls[0].invalid)
  assert.deepEqual(state.events, ["reserved", "exchange-saved", "response-accepted"])
  assert.equal(result.usage.totalTokens, 15)
})

test("MG-05/AC-23: malformed tool envelopes are rejected before committing response delivery", async () => {
  const cases = [null, {}, [], [{}], [call({ amount: "120.00" })], [call(), call()],
    [{ ...call(), id: "" }], [{ ...call(), type: "other" }], [{ ...call(), function: { name: "", arguments: "{}" } }]]
  for (const calls of cases) {
    const state = harness(envelope(calls))
    await assert.rejects(state.run())
    assert.equal(state.requests(), 1)
    assert.equal(state.executed(), 0)
    assert.deepEqual(state.events, ["reserved", "exchange-saved", "AI_RESPONSE_INVALID"])
  }
  const inconsistent = harness(envelope([call()], "stop"))
  await assert.rejects(inconsistent.run())
  assert.equal(inconsistent.executed(), 0)
  assert.deepEqual(inconsistent.events, ["reserved", "exchange-saved", "AI_RESPONSE_INVALID"])
})

test("MG-05/AC-23: empty/non-JSON arguments remain invalid through actual SDK schema checks", async () => {
  for (const args of ["", "{", "not JSON", "{}", "[]", "null"]) {
    const state = harness(envelope([call(args)]))
    const result = await state.run()
    assert.equal(state.requests(), 1)
    assert.equal(state.executed(), 0)
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].invalid, true)
    assert.deepEqual(state.events, ["reserved", "exchange-saved", "response-accepted"])
  }
})

test("MG-05/AC-23: length cannot execute even otherwise valid tool parameters and is not retried", async () => {
  const state = harness(envelope([call()], "length"))
  await assert.rejects(state.run())
  assert.equal(state.requests(), 1)
  assert.equal(state.executed(), 0)
  assert.deepEqual(state.events, ["reserved", "exchange-saved", "AI_OUTPUT_TRUNCATED"])
})
