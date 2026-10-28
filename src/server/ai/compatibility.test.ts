import assert from "node:assert/strict"
import { test } from "node:test"
import { checkEndpointCompatibility } from "../../../scripts/model-compatibility"

const env = { AI_API_KEY: "synthetic-secret", AI_MODEL: "synthetic", AI_BASE_URL: "https://synthetic.invalid/v1" }
const material = "合成专业分包付款条款：本期已到期应付100.00元，本期已付40.00元，尚未支付60.00元。"
const envelope = (message: unknown, finish = "stop") => ({ id: "synthetic", model: "synthetic", created: 1, object: "chat.completion",
  choices: [{ index: 0, finish_reason: finish, message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })

test("MG-05: explicit compatibility diagnostic exercises both actual clients with at most two safe synthetic calls", async () => {
  const bodies: Record<string, unknown>[] = []
  const report = await checkEndpointCompatibility(env, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (!body.tools) return Response.json(envelope({ role: "assistant", content: "连接成功" }))
    assert.equal(body.tools[0].function.name, "submitCheck")
    return Response.json(envelope({ role: "assistant", content: null, tool_calls: [{ id: "synthetic-call", type: "function",
      function: { name: "submitCheck", arguments: JSON.stringify({ dueYuan: "100.00", paidYuan: "40.00", unpaidYuan: "60.00", quote: material }) } }] }, "tool_calls"))
  })
  assert.equal(report.passed, true)
  assert.equal(bodies.length, 2)
  assert.deepEqual(report.stages.map(stage => [stage.client, stage.calls, stage.finishReason, stage.usage?.totalTokens]),
    [["askModel", 1, "stop", 15], ["ToolLoopAgent", 1, "tool_calls", 15]])
  assert.equal(report.scope, "configured-endpoint-only")
  assert.equal(report.endpointHost, "synthetic.invalid")
  assert.ok(report.stages.every(stage => stage.elapsedMs >= 0))
  assert.ok(!JSON.stringify(report).includes(env.AI_API_KEY))
  assert.ok(!JSON.stringify(report).includes(material))
})

test("MG-05: tool truncation is visible without repair, and missing usage stays unknown", async () => {
  let calls = 0
  const report = await checkEndpointCompatibility(env, async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    if (!body.tools) return Response.json({ choices: [{ finish_reason: "stop", message: { content: "连接成功" } }] })
    return Response.json(envelope({ role: "assistant", content: "synthetic-private-output" }, "length"))
  })
  assert.equal(calls, 2)
  assert.equal(report.passed, false)
  assert.equal(report.stages[0].usage, null)
  assert.equal(report.stages[1].finishReason, "length")
  assert.equal(report.stages[1].code, "AI_OUTPUT_TRUNCATED")
  assert.equal(report.stages[1].calls, 1)
  assert.ok(!JSON.stringify(report).includes("private"))
})
