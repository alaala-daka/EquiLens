import assert from "node:assert/strict"
import { test } from "node:test"
import { createAccountAccess } from "../auth/handlers"
import { authConfig } from "../auth/config"
import { AuthService, type AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { createProjectAuthorization } from "./authorization"
import { createProjectHandlers, type ProjectContext, type ProjectMemberContext } from "./handlers"
import { ProjectRepository } from "./repository"
import { applyProjectSchema } from "./schema"
import { ProjectService } from "./service"
import type { ProjectCreateInput } from "./types"

const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const password = "Synthetic password 123!"
const validProject: ProjectCreateInput = {
  name: "房建机电安装专业分包项目",
  source: "synthetic",
  sourceReference: "合成比赛项目",
  purpose: "合同审查与款项核对",
  retentionUntil: "2027-01-31",
}
const context = (id: string): ProjectContext => ({ params: Promise.resolve({ id }) })
const memberContext = (id: string, accountId: string): ProjectMemberContext => ({ params: Promise.resolve({ id, accountId }) })

type CallOptions = {
  method?: string
  body?: unknown
  raw?: string
  token?: string
  origin?: string | null
  headers?: Record<string, string>
}

async function setup() {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  const clock = new Date("2026-10-28T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const repository = new ProjectRepository(database, () => clock)
  const authorization = createProjectAuthorization({ repository, revalidateSession: access.revalidateAccountSession })
  const service = new ProjectService({ repository, authorization, now: () => clock })
  const handlers = createProjectHandlers(async () => ({ requireAccount: access.requireAccount, service, origin: () => site }))
  const call = (path: string, options: CallOptions = {}) => {
    const headers: Record<string, string> = { ...options.headers }
    if (options.token) headers.cookie = `__Host-equilens-auth=${options.token}`
    const method = options.method ?? "GET"
    if (method !== "GET") {
      const origin = options.origin === null ? undefined : options.origin ?? site
      if (origin !== undefined) headers.origin = origin
    }
    if ((options.body !== undefined || options.raw !== undefined) && !headers["content-type"]) headers["content-type"] = "application/json"
    const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    return new Request(`${site}${path}`, { method, headers, body })
  }
  async function create(username: string) {
    await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" })
  }
  async function login(username: string): Promise<{ token: string; identity: AuthIdentity }> {
    const result = await auth.login(username, password, "deployment")
    return { token: result.token, identity: await access.requireAccount(call("/workbench", { token: result.token })) }
  }
  return { database, auth, access, handlers, service, create, login, call }
}

async function expect(response: Response, status: number, code?: string): Promise<unknown> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  if (status === 204) {
    assert.equal(await response.text(), "")
    return null
  }
  const body = await response.json() as { error?: { code?: string; message?: string }; project?: { id?: string; role?: string; name?: string }; projects?: { id: string; role: string }[]; members?: unknown[]; member?: { role?: string } }
  if (code) {
    assert.equal(body.error?.code, code)
    assert.equal(typeof body.error?.message, "string")
    assert.doesNotMatch(JSON.stringify(body), /SQL|password|source_reference|equilens_auth|__Host/i)
  } else {
    assert.doesNotMatch(JSON.stringify(body), /source_reference|created_by|password|SQL|equilens_auth|__Host/i)
  }
  return body
}

test("C1/AC-15 HTTP: authentication, same-origin writes and fixed errors", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    await expect(await env.handlers.collection.GET(env.call("/api/projects")), 401, "UNAUTHENTICATED")
    await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", body: validProject })), 401, "UNAUTHENTICATED")
    await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, body: validProject, origin: null })), 403, "FORBIDDEN")
    await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, body: validProject, origin: "https://other.test" })), 403, "FORBIDDEN")
    await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: alice.token, origin: "https://other.test" })), 200)
    await expect(await env.handlers.collection.POST(env.call("/api/projects", {
      method: "POST", token: alice.token, raw: JSON.stringify(validProject), headers: { "content-type": "text/plain" },
    })), 400, "INVALID_INPUT")
    await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, raw: "{" })), 400, "INVALID_INPUT")
    await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, raw: JSON.stringify({ ...validProject, pad: "x".repeat(17 * 1024) }) })), 400, "INVALID_INPUT")
  } finally {
    await env.database.close()
  }
})

test("C1/AC-15 HTTP: project CRUD, roles and cross-project denial", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob"]) await env.create(username)
    const alice = await env.login("alice")
    const bob = await env.login("bob")
    const created = await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, body: validProject })), 201) as { project: { id: string; role: string } }
    assert.equal(created.project.role, "admin")
    const projectId = created.project.id

    const list = await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: alice.token })), 200) as unknown as { projects: { id: string; role: string }[]; canCreateProject: boolean }
    assert.deepEqual(list.projects.map(value => [value.id, value.role]), [[projectId, "admin"]])
    assert.equal(list.canCreateProject, true)
    await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: alice.token }), context(projectId)), 200)
    await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: bob.token }), context(projectId)), 403, "FORBIDDEN")

    const member = await expect(await env.handlers.members.POST(env.call(`/api/projects/${projectId}/members`, {
      method: "POST", token: alice.token, body: { username: "bob", role: "viewer" },
    }), context(projectId)), 201) as { member: { role: string } }
    assert.equal(member.member.role, "viewer")
    await expect(await env.handlers.members.GET(env.call(`/api/projects/${projectId}/members`, { token: alice.token }), context(projectId)), 200)
    assert.equal((await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: bob.token }), context(projectId)), 200) as { project: { role: string } }).project.role, "viewer")
    await expect(await env.handlers.members.GET(env.call(`/api/projects/${projectId}/members`, { token: bob.token }), context(projectId)), 403, "FORBIDDEN")
    await expect(await env.handlers.detail.PATCH(env.call(`/api/projects/${projectId}`, { method: "PATCH", token: bob.token, body: { name: "只读改名" } }), context(projectId)), 403, "FORBIDDEN")
    await expect(await env.handlers.members.POST(env.call(`/api/projects/${projectId}/members`, {
      method: "POST", token: bob.token, body: { username: "bob", role: "admin" },
    }), context(projectId)), 403, "FORBIDDEN")
    await expect(await env.handlers.detail.DELETE(env.call(`/api/projects/${projectId}`, { method: "DELETE", token: bob.token }), context(projectId)), 403, "FORBIDDEN")

    const updated = await expect(await env.handlers.detail.PATCH(env.call(`/api/projects/${projectId}`, { method: "PATCH", token: alice.token, body: { name: "合同审查项目 2026" } }), context(projectId)), 200) as { project: { name: string } }
    assert.equal(updated.project.name, "合同审查项目 2026")
    const bobId = bob.identity.account.id
    await expect(await env.handlers.member.DELETE(env.call(`/api/projects/${projectId}/members/${bobId}`, { method: "DELETE", token: alice.token }), memberContext(projectId, bobId)), 204)
    await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: bob.token }), context(projectId)), 403, "FORBIDDEN")
    await expect(await env.handlers.detail.DELETE(env.call(`/api/projects/${projectId}`, { method: "DELETE", token: alice.token }), context(projectId)), 204)
    await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: alice.token }), context(projectId)), 403, "FORBIDDEN")
    const empty = await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: alice.token })), 200) as unknown as { projects: unknown[] }
    assert.deepEqual(empty.projects, [])
  } finally {
    await env.database.close()
  }
})

test("C1/AC-15 HTTP: superadmin exception, account maintenance and revocation", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "root", "eve"]) await env.create(username)
    const alice = await env.login("alice")
    const created = await expect(await env.handlers.collection.POST(env.call("/api/projects", { method: "POST", token: alice.token, body: validProject })), 201) as { project: { id: string } }
    const projectId = created.project.id

    await env.auth.maintain({ action: "grant-admin", username: "root", actor: "synthetic-operator" })
    const root = await env.login("root")
    assert.equal((await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: root.token })), 200) as unknown as { projects: { id: string }[] }).projects.length, 1)
    assert.equal((await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: root.token }), context(projectId)), 200) as { project: { role: string } }).project.role, "admin")
    await expect(await env.handlers.detail.GET(env.call("/api/projects/00000000-0000-4000-8000-000000000000", { token: root.token }), context("00000000-0000-4000-8000-000000000000")), 404, "NOT_FOUND")

    const eve = await env.login("eve")
    const eveList = await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: eve.token })), 200) as unknown as { projects: unknown[]; canCreateProject: boolean }
    assert.deepEqual(eveList.projects, [])
    assert.equal(eveList.canCreateProject, true)
    await expect(await env.handlers.detail.GET(env.call(`/api/projects/${projectId}`, { token: eve.token }), context(projectId)), 403, "FORBIDDEN")
    await expect(await env.handlers.detail.GET(env.call("/api/projects/00000000-0000-4000-8000-000000000000", { token: eve.token }), context("00000000-0000-4000-8000-000000000000")), 403, "FORBIDDEN")

    await env.auth.logout(alice.token)
    await expect(await env.handlers.collection.GET(env.call("/api/projects", { token: alice.token })), 401, "UNAUTHENTICATED")
  } finally {
    await env.database.close()
  }
})

test("C1/AC-15 HTTP: service and auth failures are fixed 503 responses", async () => {
  const failure = async (services: () => Promise<never>) => {
    const handlers = createProjectHandlers(services)
    return handlers.collection.GET(new Request(`${site}/api/projects`))
  }
  const broken = await failure(async () => { throw new Error("SQL password secret from database") })
  assert.equal(broken.status, 503)
  assert.equal(broken.headers.get("cache-control"), "private, no-store")
  const body = await broken.text()
  assert.match(body, /SERVICE_UNAVAILABLE/)
  assert.doesNotMatch(body, /SQL|password|secret|database/)
})
