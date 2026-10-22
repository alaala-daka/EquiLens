import assert from "node:assert/strict"
import { test } from "node:test"
import { askModel, modelConfig, ModelError } from "./client"

const config = { endpoint: "https://gateway.invalid/v1/chat/completions", apiKey: "synthetic-secret", model: "glm-5.3-flash" }
const valid = () => ({ model: "glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: "连接成功" } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })

test("MG-01: config requires a key and keeps the configured gateway path", () => {
  assert.throws(() => modelConfig({}), { code: "AI_NOT_CONFIGURED" })
  const value = modelConfig({ AI_API_KEY: "synthetic-secret", AI_BASE_URL: "https://gateway.invalid/custom/v1/", AI_MODEL: "glm-5.3-flash" })
  assert.equal(value.endpoint, "https://gateway.invalid/custom/v1/chat/completions")
  assert.equal(value.model, "glm-5.3-flash")
  for (const address of ["http://gateway.invalid/v1", "not a url", "https://user:password@gateway.invalid/v1", "https://gateway.invalid/v1?key=hidden", "https://gateway.invalid/v1#fragment"]) {
    assert.throws(() => modelConfig({ AI_API_KEY: "synthetic-secret", AI_BASE_URL: address }), error => error instanceof ModelError && error.code === "AI_CONFIG_INVALID" && !error.message.includes("password"))
  }
})

test("MG-02: one non-streaming request uses only server config and returns checked fields", async () => {
  let calls = 0
  const result = await askModel("你好", config, async (url, init) => {
    calls++
    assert.equal(url, config.endpoint)
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-secret")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    assert.deepEqual(JSON.parse(String(init?.body)), { model: config.model, messages: [{ role: "user", content: "你好" }], stream: false, max_tokens: 256 })
    return Response.json(valid())
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { text: "连接成功", model: "glm-5.3-flash", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } })
})

test("MG-01: empty or oversized inputs never call the gateway", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(valid()) }
  for (const prompt of ["", "   ", "字".repeat(20001), null]) {
    await assert.rejects(askModel(prompt as string, config, fetcher), { code: "AI_INPUT_INVALID" })
  }
  assert.equal(calls, 0)
})

test("MG-03: HTTP errors and network failures are distinct and do not expose provider details", async () => {
  const cases = [[401, "AI_AUTH_ERROR"], [403, "AI_AUTH_ERROR"], [402, "AI_UPSTREAM_ERROR"], [429, "AI_RATE_LIMITED"], [500, "AI_UPSTREAM_ERROR"]] as const
  for (const [status, code] of cases) {
    await assert.rejects(askModel("你好", config, async () => new Response("provider says synthetic-secret", { status })), error => error instanceof ModelError && error.code === code && !String(error).includes("synthetic-secret"))
  }
  await assert.rejects(askModel("你好", config, async () => { throw new Error("sensitive endpoint synthetic-secret") }), { code: "AI_NETWORK_ERROR" })
  await assert.rejects(askModel("你好", config, async () => { throw new DOMException("synthetic-secret", "TimeoutError") }), { code: "AI_TIMEOUT" })
})

test("MG-03: truncated, empty, refused, tool and malformed responses never become successful text", async () => {
  const bad = [
    {}, { choices: [] },
    { choices: [{ finish_reason: "length", message: { content: "部分回答" } }] },
    { choices: [{ finish_reason: "stop", message: { content: " " } }] },
    { choices: [{ finish_reason: "stop", message: { content: "拒绝", refusal: "reason" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "工具", tool_calls: [{}] } }] },
  ]
  for (const value of bad) await assert.rejects(askModel("你好", config, async () => Response.json(value)), ModelError)
  await assert.rejects(askModel("你好", config, async () => new Response("not JSON")), { code: "AI_RESPONSE_INVALID" })
  await assert.rejects(askModel("你好", config, async () => new Response("x".repeat(1024 * 1024 + 1))), { code: "AI_RESPONSE_INVALID" })
})

test("MG-03: usage is optional and malformed metadata is not trusted", async () => {
  const value = valid() as Record<string, unknown>
  value.model = { unexpected: "object" }
  value.usage = { prompt_tokens: -1, completion_tokens: "NaN", total_tokens: 0 }
  const result = await askModel("你好", config, async () => Response.json(value))
  assert.equal(result.model, config.model)
  assert.equal(result.usage, null)
})
