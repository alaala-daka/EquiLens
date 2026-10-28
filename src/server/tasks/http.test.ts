import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { AuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { TaskError } from "./errors"
import { createTaskCollectionHandlers, createTaskDetailHandlers, type TaskHttpServices } from "./http"
import type { TaskView } from "./repository"

const origin = "https://equilens.invalid"
const taskId = "11111111-1111-4111-8111-111111111111"
// The task HTTP adapter trusts only APP_ORIGIN (via authConfig), like A1.
process.env.APP_ORIGIN = origin
const identity: AuthIdentity = {
  account: { id: "account-1", username: "member", role: "member" },
  session: { id: "session-1", expiresAt: Date.now() + 3_600_000 },
}
const task: TaskView = {
  id: taskId,
  kind: "contract-review",
  projectId: "project-1",
  state: "queued",
  stage: "submitted",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  attempt: 0,
  maxAttempts: 3,
  callsUsed: 0,
  maxCalls: 25,
  elapsedMs: 0,
  manifest: {
    version: 1, catalogVersion: 1, kind: "contract-review", projectId: "project-1",
    refs: { document: { projectId: "project-1", id: "document-1", versionId: "document-1-version" } },
    conditions: {}, submittedBy: "account-1", submittedAt: "2026-10-28T00:00:00.000Z",
  },
  error: null,
  resultSummary: null,
}
const body = {
  kind: "contract-review",
  projectId: "project-1",
  refs: { document: { projectId: "project-1", id: "document-1", versionId: "document-1-version" } },
  conditions: {},
}

function request(path: string, options: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  return new NextRequest(origin + path, {
    method: options.method ?? "GET",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

function services(overrides: Partial<TaskHttpServices> = {}) {
  const seen: { submission?: unknown; authorized: string[] } = { authorized: [] }
  const value: TaskHttpServices = {
    identity: async () => identity,
    authorize: async (_identity, projectId, action) => { seen.authorized.push(`${action}:${projectId}`) },
    submit: async (_identity, _authorize, submission) => {
      seen.submission = submission
      await _authorize(_identity, submission.projectId, "edit")
      return { task, created: true }
    },
    get: async () => task,
    list: async (_identity, _authorize, projectId) => { await _authorize(_identity, projectId, "read"); return [task] },
    ...overrides,
  }
  return { seen, value }
}

test("A3a: thin HTTP submission requires same origin, JSON and an operationId", async () => {
  const { seen, value } = services()
  const handlers = createTaskCollectionHandlers(async () => value)
  const missing = await handlers.POST(request("/api/tasks", { method: "POST", body }))
  assert.equal(missing.status, 422)
  assert.equal((await missing.json()).error.code, "INVALID_SUBMISSION")

  const crossOrigin = await handlers.POST(request("/api/tasks", { method: "POST", body, headers: { Origin: "https://other.invalid", "Idempotency-Key": "operation-http" } }))
  assert.equal(crossOrigin.status, 403)
  assert.equal((await crossOrigin.json()).error.code, "FORBIDDEN")

  const wrongType = await handlers.POST(request("/api/tasks", { method: "POST", raw: JSON.stringify(body), headers: { "Content-Type": "text/plain", "Idempotency-Key": "operation-http" } }))
  assert.equal(wrongType.status, 415)
  assert.equal((await wrongType.json()).error.code, "INVALID_SUBMISSION")

  const created = await handlers.POST(request("/api/tasks", { method: "POST", body, headers: { "Idempotency-Key": "operation-http" } }))
  assert.equal(created.status, 202)
  assert.equal(created.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(await created.json(), { task, created: true })
  assert.equal((seen.submission as { operationId: string }).operationId, "operation-http")
  assert.deepEqual(seen.authorized, ["edit:project-1"])
})

test("A3a: missing or invalid APP_ORIGIN fails closed instead of trusting request.url", async () => {
  const handlers = createTaskCollectionHandlers(async () => services().value)
  const saved = process.env.APP_ORIGIN
  try {
    delete process.env.APP_ORIGIN
    const missing = await handlers.POST(request("/api/tasks", { method: "POST", body, headers: { "Idempotency-Key": "operation-http" } }))
    assert.equal(missing.status, 503)
    assert.equal((await missing.json()).error.code, "SERVICE_UNAVAILABLE")

    process.env.APP_ORIGIN = "not-a-valid-origin"
    const invalid = await handlers.POST(request("/api/tasks", { method: "POST", body, headers: { "Idempotency-Key": "operation-http" } }))
    assert.equal(invalid.status, 503)
    assert.equal((await invalid.json()).error.code, "SERVICE_UNAVAILABLE")
  } finally {
    if (saved === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = saved
  }
})

test("A3a: the body limit is enforced by streaming and never trusts Content-Length", async () => {
  const handlers = createTaskCollectionHandlers(async () => services().value)
  const oversized = JSON.stringify({ ...body, pad: "x".repeat(300 * 1024) })
  const requestWithSpoofedLength = request("/api/tasks", {
    method: "POST", raw: oversized,
    headers: { "Idempotency-Key": "operation-http", "Content-Length": "10" },
  })
  const response = await handlers.POST(requestWithSpoofedLength)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, "INVALID_SUBMISSION")
  assert.equal(response.headers.get("cache-control"), "private, no-store")
})

test("A3a: C1 project-guard BusinessErrors keep 401/403/404 instead of falling back to 503", async () => {
  const failing = async (failure: unknown) => createTaskCollectionHandlers(async () => services({
    submit: async () => { throw failure },
  }).value).POST(request("/api/tasks", { method: "POST", body, headers: { "Idempotency-Key": "operation-http" } }))

  const unauthenticated = await failing(new BusinessError("UNAUTHENTICATED", "请先登录。"))
  assert.equal(unauthenticated.status, 401)
  assert.equal((await unauthenticated.json()).error.code, "UNAUTHENTICATED")

  const forbidden = await failing(new BusinessError("FORBIDDEN", "无权访问该项目。"))
  assert.equal(forbidden.status, 403)
  assert.deepEqual((await forbidden.json()).error, { code: "FORBIDDEN", message: "无权访问该项目。" })
  assert.equal(forbidden.headers.get("cache-control"), "private, no-store")

  const absent = await failing(new BusinessError("NOT_FOUND", "找不到该项目。"))
  assert.equal(absent.status, 404)
  assert.equal((await absent.json()).error.code, "NOT_FOUND")

  const conflict = await failing(new TaskError(409, "CONFLICT", "此提交标识已用于不同的任务输入。"))
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, "CONFLICT")

  const limited = await failing(new TaskError(429, "LIMIT_EXCEEDED", "任务队列已满，请稍后提交。"))
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get("cache-control"), "private, no-store")

  const authUnavailable = await failing(new AuthError("UNAUTHENTICATED", "请先登录。"))
  assert.equal(authUnavailable.status, 401)
  assert.equal((await authUnavailable.json()).error.code, "UNAUTHENTICATED")

  const badOrigin = await failing(new AuthError("INVALID_ORIGIN", "内部来源错误细节。"))
  assert.equal(badOrigin.status, 403)
  assert.deepEqual((await badOrigin.json()).error, { code: "FORBIDDEN", message: "请求来源无效。" })

  const unavailable = await failing(new Error("SQLITE_BUSY at equilens_tasks"))
  assert.equal(unavailable.status, 503)
  const value = await unavailable.json()
  assert.equal(value.error.code, "SERVICE_UNAVAILABLE")
  assert.doesNotMatch(JSON.stringify(value), /SQLITE|equilens_tasks|owner/)
})

test("A3a: task HTTP reads are project-scoped and detail ids are validated", async () => {
  const { value } = services()
  const collection = createTaskCollectionHandlers(async () => value)
  assert.equal((await collection.GET(request("/api/tasks"))).status, 422)
  const listed = await collection.GET(request("/api/tasks?projectId=project-1"))
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).tasks, [task])

  const detail = createTaskDetailHandlers(async () => value)
  const malformed = await detail.GET(request("/api/tasks/not-a-uuid"), { params: Promise.resolve({ id: "not-a-uuid" }) })
  assert.equal(malformed.status, 422)
  assert.equal((await malformed.json()).error.code, "INVALID_SUBMISSION")
  const found = await detail.GET(request(`/api/tasks/${taskId}`), { params: Promise.resolve({ id: taskId }) })
  assert.equal(found.status, 200)
  assert.equal((await found.json()).id, taskId)
})

test("A3c HTTP rejects browser model, price and budget fields before submit", async () => {
  for (const field of ["model", "price", "budget", "operationId", "executor"]) {
    const { seen, value } = services()
    const handlers = createTaskCollectionHandlers(async () => value)
    const response = await handlers.POST(request("/api/tasks", { method: "POST", body: { ...body, [field]: "untrusted" }, headers: { "Idempotency-Key": "strict" } }))
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error.code, "INVALID_SUBMISSION")
    assert.equal(seen.submission, undefined)
  }
})
