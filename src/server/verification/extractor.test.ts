import assert from "node:assert/strict"
import { test } from "node:test"
import { bidRequirementPrompt, createBidRequirementExtractor, type BidRequirementExtractorInput } from "./extractor"

/**
 * C4-VERIFY production extractor contract (plan §4.7/§5; review blocker 1).
 *
 * The model may only propose candidates, every request is reserved before it
 * leaves the process, and the tender text is never silently truncated: a prompt
 * over the 60,000-character cap fails with a controlled EXTRACTOR_FAILED before
 * any model call (the task input cap is 120,000, so the task fails honestly
 * instead of producing a partial "全面资格要求" extraction).
 */
const env = { AI_API_KEY: "synthetic-secret", AI_BASE_URL: "https://gateway.invalid/v1", AI_MODEL: "synthetic-model" }

function input(paragraphTexts: string[], overrides: Partial<BidRequirementExtractorInput> = {}): BidRequirementExtractorInput {
  return {
    paragraphs: paragraphTexts.map((text, index) => ({
      fragmentId: `fragment-${index}`, snapshotId: "snapshot-1", materialVersionId: "tender-1", text,
    })),
    complete: true,
    maxCalls: 2,
    signal: new AbortController().signal,
    env,
    onBeforeCall: async () => {},
    onExchange: async () => {},
    ...overrides,
  }
}

function modelResponse(content: string, finishReason = "stop") {
  return Response.json({
    model: "synthetic-model",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

test("extractor: tender text over the prompt cap fails before any model call (no silent truncation)", async () => {
  const prompts: BidRequirementExtractorInput[] = []
  const promptInput = input(["字".repeat(60_001)])
  assert.throws(() => bidRequirementPrompt(promptInput), { code: "EXTRACTOR_FAILED" })
  assert.equal(prompts.length, 0)
  let fetcherCalls = 0
  const extractor = createBidRequirementExtractor({
    fetcher: async () => { fetcherCalls++; return modelResponse("{\"candidates\":[]}") },
  })
  await assert.rejects(extractor(input(["字".repeat(60_001)])), { code: "EXTRACTOR_FAILED" })
  assert.equal(fetcherCalls, 0)
  // Just under the cap still builds a complete prompt (all paragraphs included).
  const underCap = input(["a".repeat(50_000), "b".repeat(5_000)])
  const prompt = bidRequirementPrompt(underCap)
  assert.ok(prompt.includes("a".repeat(100)))
  assert.ok(prompt.includes("b".repeat(100)))
  assert.ok(prompt.length <= 60_000)
})

test("extractor: missing model configuration fails as SERVICE_UNAVAILABLE before any reserved call", async () => {
  let calls = 0
  let fetcherCalls = 0
  const extractor = createBidRequirementExtractor({ fetcher: async () => { fetcherCalls++; return modelResponse("{}") } })
  await assert.rejects(extractor(input(["投标人应具有营业执照。"], {
    env: {},
    onBeforeCall: async () => { calls++ },
  })), { code: "SERVICE_UNAVAILABLE" })
  assert.equal(calls, 0)
  assert.equal(fetcherCalls, 0)
})

test("extractor: one reserved call parses a code-fenced candidate JSON and reports usage", async () => {
  const calls: number[] = []
  const exchanges: unknown[] = []
  const requests: Array<{ model: string; maxTokens: number; prompt: string }> = []
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number; messages: Array<{ content: string }> }
    requests.push({ model: body.model, maxTokens: body.max_tokens, prompt: body.messages[0].content })
    return modelResponse("```json\n{\"candidates\":[{\"subject\":\"投标人\",\"quote\":\"投标人应具有营业执照\"}]}\n```")
  }
  const extractor = createBidRequirementExtractor({ fetcher: fetcher as typeof fetch })
  const raw = await extractor(input(["投标人应具有营业执照。"], {
    asOf: "2026-10-29",
    onBeforeCall: async ({ callNumber }) => { calls.push(callNumber) },
    onExchange: async exchange => { exchanges.push(exchange) },
  }))
  assert.deepEqual(calls, [1])
  assert.equal(exchanges.length, 1)
  assert.equal((raw as { candidates: unknown[] }).candidates.length, 1)
  assert.equal(requests[0].model, "synthetic-model")
  assert.equal(requests[0].maxTokens, 2000)
  assert.ok(requests[0].prompt.includes("投标人应具有营业执照。"))
  assert.ok(requests[0].prompt.includes("2026-10-29"))
})

test("extractor: malformed output is retried at most once then fails; maxCalls bounds it", async () => {
  let calls = 0
  const extractor = createBidRequirementExtractor({ fetcher: async () => modelResponse("不是 JSON") })
  await assert.rejects(extractor(input(["投标人应具有营业执照。"], {
    onBeforeCall: async ({ callNumber }) => { calls++; assert.ok(callNumber <= 2) },
  })), { code: "EXTRACTOR_FAILED" })
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(createBidRequirementExtractor({ fetcher: async () => modelResponse("不是 JSON") })(
    input(["投标人应具有营业执照。"], {
      maxCalls: 1,
      onBeforeCall: async ({ callNumber }) => { calls++; assert.equal(callNumber, 1) },
    }),
  ), { code: "EXTRACTOR_FAILED" })
  assert.equal(calls, 1)
})

test("extractor: an upstream HTTP failure fails honestly after bounded retries", async () => {
  let calls = 0
  const extractor = createBidRequirementExtractor({ fetcher: async () => new Response("{\"error\":\"busy\"}", { status: 429 }) })
  await assert.rejects(extractor(input(["投标人应具有营业执照。"], {
    onBeforeCall: async () => { calls++ },
  })), { code: "EXTRACTOR_FAILED" })
  assert.equal(calls, 2)
})
