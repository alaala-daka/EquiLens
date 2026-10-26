import assert from "node:assert/strict"
import { test } from "node:test"
import { createAgentModel } from "../src/agent/model"
import { ReviewError } from "../src/errors"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-secret" }

test("AC-23/24：异常结束先保留有界响应，区分截断、拒绝和未知原因，不能提交阅读记录", async () => {
  for (const [finish, refusal, expected] of [
    ["length", null, "AI_OUTPUT_TRUNCATED"],
    ["content_filter", null, "AI_OUTPUT_REFUSED"],
    ["stop", "synthetic-private-refusal", "AI_OUTPUT_REFUSED"],
    ["unexpected", null, "AI_OUTPUT_INCOMPLETE"],
  ]) {
    const events: string[] = []
    const exchanges: unknown[] = []
    let requests = 0
    const { model } = createAgentModel({
      env, signal: new AbortController().signal, maxPromptChars: 64000, requestTimeoutMs: 5000,
      beforeRequest: async () => { events.push("reserved") }, afterResponse: () => events.push("read-committed"),
      onFailure: failure => events.push(failure.code),
      onExchange: async exchange => { events.push("saved"); exchanges.push(exchange) },
      fetcher: async () => { requests++; return Response.json({
        choices: [{ finish_reason: finish, message: { content: "synthetic-private-content", refusal } }],
      }) },
    })
    await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "合成输入" }] }],
      maxOutputTokens: 8192 }), (failure: unknown) => {
      assert.ok(failure instanceof Error)
      assert.ok(!failure.message.includes("private"))
      return true
    })
    const repaired = finish === "length"
    assert.deepEqual(events, repaired ? ["reserved", "saved", "reserved", "saved", expected] : ["reserved", "saved", expected])
    assert.equal(requests, repaired ? 2 : 1)
    assert.equal(exchanges.length, requests)
    assert.ok(!JSON.stringify(exchanges).includes(env.AI_API_KEY))
  }
})

test("AC-23：失败响应写入失败时停止，不执行工具或提交阅读记录", async () => {
  const failures: string[] = []
  const { model } = createAgentModel({
    env, signal: new AbortController().signal, maxPromptChars: 64000, requestTimeoutMs: 5000,
    beforeRequest: async () => {}, afterResponse: () => assert.fail("must not commit reads"),
    onFailure: failure => failures.push(failure.code), onExchange: async () => { throw new Error("private database detail") },
    fetcher: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
  })
  await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "合成输入" }] }] }))
  assert.deepEqual(failures, ["REVIEW_PROGRESS_FAILED"])
})

test("AC-23：截断修正也须在外发前预留预算，预留失败不重发", async () => {
  let reservations = 0
  let requests = 0
  const failures: string[] = []
  const { model } = createAgentModel({
    env, signal: new AbortController().signal, maxPromptChars: 64000, requestTimeoutMs: 5000,
    beforeRequest: async () => { if (++reservations === 2) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED") },
    afterResponse: () => assert.fail("must not commit reads"), onFailure: failure => failures.push(failure.code),
    fetcher: async () => { requests++; return Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }) },
  })
  await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "合成输入" }] }] }))
  assert.equal(reservations, 2)
  assert.equal(requests, 1)
  assert.deepEqual(failures, ["REVIEW_BUDGET_EXHAUSTED"])
})

test("AC-23：一次尝试修正成功后，后续回合再次截断不能再次修正", async () => {
  let calls = 0
  const failures: string[] = []
  const { model } = createAgentModel({
    env, signal: new AbortController().signal, maxPromptChars: 64000, requestTimeoutMs: 5000,
    beforeRequest: async () => {}, afterResponse: () => {}, onFailure: failure => failures.push(failure.code),
    fetcher: async () => {
      calls++
      return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic",
        choices: [{ index: 0, finish_reason: calls === 2 ? "stop" : "length", message: { role: "assistant", content: "合成回答" } }] })
    },
  })
  const request = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "合成输入" }] }] }
  await model.doGenerate(request)
  assert.equal(calls, 2)
  await assert.rejects(async () => model.doGenerate(request))
  assert.equal(calls, 3)
  assert.deepEqual(failures, ["AI_OUTPUT_TRUNCATED"])
})
