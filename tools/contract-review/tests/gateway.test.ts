import assert from "node:assert/strict"
import { test } from "node:test"
import { createGatewayAskModel } from "../src/gateway"

const env = { AI_API_KEY: "synthetic-secret", AI_BASE_URL: "https://gateway.invalid/v1", AI_MODEL: "synthetic-model" }
const ok = (message: Record<string, unknown> = { content: '{"findings":[]}' }) => Response.json({
  choices: [{ finish_reason: "stop", message }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})

test("AC-24：网关保留 system/user，单次请求不自行重试", async () => {
  let calls = 0
  const model = createGatewayAskModel({
    env, fetcher: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.messages[0].role, "system")
      assert.equal(body.messages[1].role, "user")
      assert.equal(body.stream, false)
      assert.equal(init?.redirect, "error")
      return ok()
    },
  })
  assert.equal((await model({ system: "s", user: "u" })).usage?.totalTokens, 15)
  assert.equal(calls, 1)
})

test("AC-23：永久4xx不伪装为可重试上游故障，不泄漏响应正文", async () => {
  for (const status of [400, 401, 402, 403, 404, 422]) {
    let calls = 0
    const model = createGatewayAskModel({
      env, fetcher: async () => { calls++; return new Response("synthetic private upstream body", { status }) },
    })
    await assert.rejects(model({ system: "s", user: "u" }), (failure: unknown) =>
      failure instanceof Error && !failure.message.includes("private") &&
      "code" in failure && ["AI_AUTH_ERROR", "AI_REQUEST_REJECTED"].includes(String(failure.code)))
    assert.equal(calls, 1)
  }
})

test("AC-24：配置缺失、网络失败、截断、拒绝、工具调用及非法响应明确失败", async () => {
  const missing = createGatewayAskModel({ env: {}, fetcher: async () => { throw new Error("should not run") } })
  await assert.rejects(missing({ system: "s", user: "u" }), { code: "AI_NOT_CONFIGURED" })
  const network = createGatewayAskModel({ env, fetcher: async () => { throw new Error("synthetic-private-detail") } })
  await assert.rejects(network({ system: "s", user: "u" }), { code: "AI_NETWORK_ERROR" })
  const responses = [
    Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
    ok({ content: "{}", refusal: "denied" }),
    ok({ content: "{}", tool_calls: [{ id: "synthetic" }] }),
    Response.json({ choices: [null] }),
    new Response("not JSON"),
    new Response("x".repeat(1024 * 1024 + 1)),
  ]
  for (const response of responses) {
    const model = createGatewayAskModel({ env, fetcher: async () => response })
    await assert.rejects(model({ system: "s", user: "u" }))
  }
})

test("AC-23：限流携带 Retry-After，供统一编排计入时限和预算", async () => {
  const model = createGatewayAskModel({
    env, fetcher: async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
  })
  await assert.rejects(model({ system: "s", user: "u" }), { code: "AI_RATE_LIMITED", retryAfterMs: 2000 })
})

test("AC-24：请求和响应读取共用超时，支持父任务取消", async () => {
  const model = createGatewayAskModel({
    env, timeoutMs: 5,
    fetcher: async (_url, init) => new Promise((_accept, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }),
  })
  await assert.rejects(model({ system: "s", user: "u" }), { code: "AI_TIMEOUT" })
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const cancelled = createGatewayAskModel({ env, fetcher: async () => { calls++; return ok() } })
  await assert.rejects(cancelled({ system: "s", user: "u", signal: controller.signal }), { code: "REVIEW_CANCELLED" })
  assert.equal(calls, 0)
})
