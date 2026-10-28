import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { createReviewCollectionHandlers, createReviewDetailHandlers, createRevisionSubmissionHandler, type ReviewHttpServices } from "./handlers"
import { setup } from "./test-fixtures"

test("AC-01/23: review HTTP checks context/origin/consent and revalidates after serialization", async t => {
  const s = await setup()
  let wakeCount = 0
  const services: ReviewHttpServices = { sessions: s.sessions, repository: s.repository,
    configuration: async () => ({ ready: false, mode: "published", model: "", providerHost: "", retentionDays: 0, maxKnownTokens: 0, configurationId: "" }),
    submit: (owner, key, request, contextId) => s.repository.create(owner, key, request, { ...s.input, documentContextId: contextId }, 3, 7),
    submitRevision: async () => { throw new Error("not used") },
    wake: () => { wakeCount++ }, cancel: () => {} }
  const collection = createReviewCollectionHandlers(async () => services)
  const details = createReviewDetailHandlers(async () => services)
  const origin = "https://equilens.invalid"
  const request = (method = "GET", body?: unknown, headers?: Record<string, string>) => new NextRequest(`${origin}/api/contract-reviews`, {
    method, headers: { Origin: origin, Cookie: `equilens_session=${s.token}`, "X-Document-Context": s.contextId, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const denied = async (response: Response, status: number, code?: string) => {
    assert.equal(response.status, status)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    const value = await response.json()
    if (code) assert.equal(value.code, code)
    assert.doesNotMatch(JSON.stringify(value), /"owner"|"paragraphs"|password|SQL|equilens_session/)
  }
  try {
    await denied(await collection.GET(request("GET", undefined, { "X-Document-Context": "" })), 400, "SESSION_CONTEXT_REQUIRED")
    await denied(await collection.GET(request("GET", undefined, { "X-Document-Context": randomUUID() })), 409, "SESSION_CHANGED")
    await denied(await collection.POST(request("POST", s.request, { Origin: "https://other.invalid" })), 403)
    await denied(await collection.POST(request("POST", { ...s.request, externalProcessingConsent: false })), 422)
    await denied(await collection.POST(request("POST", { ...s.request, context: { ...s.request.context, scene: "mep-sub-2026" } })), 422)
    await denied(await collection.POST(request("POST", { ...s.request, context: { scene: "auto", region: "上海" } })), 422)
    const created = await collection.POST(request("POST", s.request))
    assert.equal(created.status, 202)
    assert.equal(created.headers.get("X-Document-Context"), s.contextId)
    assert.equal(wakeCount, 1)
    const task = await created.json()
    const context = { params: Promise.resolve({ id: task.id }) }
    await denied(await details.POST(request("POST", { action: "retry" }), context), 422)
    assert.equal((await details.GET(request(), context)).status, 200)
    const expiry = new Date((await s.sessions.view(s.owner)).expiresAt!)
    const originalGet = s.repository.get.bind(s.repository)
    t.mock.method(s.repository, "get", async (...args: Parameters<typeof originalGet>) => {
      const result = await originalGet(...args)
      Object.defineProperty(result, "toJSON", { value: () => { s.setClock(expiry); return result } })
      return result
    })
    await denied(await details.GET(request(), context), 410, "RETENTION_EXPIRED")
    await denied(await collection.POST(request("POST", s.request)), 410, "RETENTION_EXPIRED")
    await denied(await collection.GET(request()), 410, "RETENTION_EXPIRED")
  } finally { await s.close() }
})

test("AC-09/23: revision POST requires consent and selected rule ids", async () => {
  const s = await setup()
  try {
    const task = await s.create()
    let received: { id: string; rules: string[] } | null = null
    const services: ReviewHttpServices = { sessions: s.sessions, repository: s.repository,
      configuration: async () => ({ ready: false, mode: "published", model: "", providerHost: "", retentionDays: 0, maxKnownTokens: 0, configurationId: "" }),
      submit: async () => { throw new Error("not used") },
      submitRevision: async (_owner, _key, id, rules) => { received = { id, rules }; return task },
      wake: () => {}, cancel: () => {} }
    const handler = createRevisionSubmissionHandler(async () => services)
    const origin = "https://equilens.invalid"
    const request = (body: unknown) => new NextRequest(origin + "/api/contract-reviews/" + task.id + "/revision", { method: "POST",
      headers: { Origin: origin, Cookie: `equilens_session=${s.token}`, "X-Document-Context": s.contextId, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body) })
    const context = { params: Promise.resolve({ id: task.id }) }
    assert.equal((await handler(request({ ruleIds: ["T-001"] }), context)).status, 422)
    const response = await handler(request({ externalProcessingConsent: true, ruleIds: ["T-001"] }), context)
    assert.equal(response.status, 202)
    assert.deepEqual(received, { id: task.id, rules: ["T-001"] })
  } finally { await s.close() }
})
