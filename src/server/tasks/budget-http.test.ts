import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { TaskError } from "./errors"
import { createProjectBudgetHandlers, type ProjectBudgetDependencies } from "./budget-http"
import type { ProjectBudgetView } from "./budget"

const origin = "https://equilens.test"
const projectId = "11111111-1111-4111-8111-111111111111"
const identity: AuthIdentity = {
  account: { id: "account-1", username: "admin", role: "member" },
  session: { id: "session-1", expiresAt: Date.now() + 3_600_000 },
}
const view: ProjectBudgetView = {
  projectId, costLimitFen: 3000, costReservedFen: 0, costChargedFen: 0, remainingFen: 3000,
  registeredBy: "account-1", registeredAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z", revision: 1,
}

function handlers(dependencies: Partial<ProjectBudgetDependencies> = {}) {
  return createProjectBudgetHandlers(async () => ({ identity: async () => identity, authorize: async () => ({}) }), {
    read: async () => view,
    register: async (_identity, _authorize, _projectId, costLimitFen) => ({ ...view, costLimitFen }),
    ...dependencies,
  })
}

function request(path: string, options: { method?: string; body?: unknown; origin?: string; contentType?: string } = {}) {
  return new NextRequest(`https://equilens.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.origin === undefined ? { Origin: origin } : options.origin ? { Origin: options.origin } : {}),
      ...(options.contentType === undefined ? {} : { "Content-Type": options.contentType }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

const context = (id = projectId) => ({ params: Promise.resolve({ id }) })

async function withOrigin(work: () => Promise<void>) {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  try { await work() } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = previous
  }
}

test("project budget GET returns the configured budget with private no-store", async () => {
  await withOrigin(async () => {
    const response = await handlers().GET(request(`/api/projects/${projectId}/budget`), context())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(await response.json(), { budget: view })
  })
})

test("project budget GET maps authorization failures without leaking details", async () => {
  await withOrigin(async () => {
    const response = await handlers({ read: async () => { throw new BusinessError("FORBIDDEN", "无权访问该项目。") } })
      .GET(request(`/api/projects/${projectId}/budget`), context())
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: { code: "FORBIDDEN", message: "无权访问该项目。" } })
  })
})

test("project budget POST requires same origin, JSON and a bounded integer", async () => {
  await withOrigin(async () => {
    const badOrigin = await handlers().POST(request(`/api/projects/${projectId}/budget`, { method: "POST", body: { costLimitFen: 3000 }, origin: "https://evil.test", contentType: "application/json" }), context())
    assert.equal(badOrigin.status, 403)
    const badType = await handlers().POST(request(`/api/projects/${projectId}/budget`, { method: "POST", body: { costLimitFen: 3000 }, contentType: "text/plain" }), context())
    assert.equal(badType.status, 400)
    for (const body of [{}, { costLimitFen: -1 }, { costLimitFen: 1.5 }, { costLimitFen: 3000, extra: true }]) {
      const response = await handlers().POST(request(`/api/projects/${projectId}/budget`, { method: "POST", body, contentType: "application/json" }), context())
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { error: { code: string } }).error.code, "INVALID_INPUT")
    }
  })
})

test("project budget POST registers the ceiling and maps domain conflicts", async () => {
  await withOrigin(async () => {
    const response = await handlers().POST(request(`/api/projects/${projectId}/budget`, { method: "POST", body: { costLimitFen: 3000 }, contentType: "application/json" }), context())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { budget: { ...view, costLimitFen: 3000 } })
    const conflict = await handlers({ register: async () => { throw new TaskError(409, "CONFLICT", "预算登记冲突。") } })
      .POST(request(`/api/projects/${projectId}/budget`, { method: "POST", body: { costLimitFen: 3000 }, contentType: "application/json" }), context())
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, "CONFLICT")
  })
})
