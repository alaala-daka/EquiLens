import assert from "node:assert/strict"
import { test } from "node:test"
import { createAccountAccess } from "../auth/handlers"
import { authConfig } from "../auth/config"
import { AuthService, type AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { createProjectAuthorization } from "./authorization"
import { createProjectHandlers, type ProjectContext } from "./handlers"
import { applyProjectLifecycleSchema, type ProjectDeletionRecord } from "./lifecycle-schema"
import { ProjectRepository } from "./repository"
import { applyProjectSchema } from "./schema"
import { ProjectService, type ProjectDeletionPort } from "./service"
import { BusinessError } from "./errors"
import type { ProjectDeletionIntent, ProjectDeletionJournal } from "./deletion-journal"
import { journalIntentForRecord } from "./reclamation"

const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const password = "Synthetic password 123!"
const context = (id: string): ProjectContext => ({ params: Promise.resolve({ id }) })
const projectInput = { name: "合成项目", source: "synthetic" as const, sourceReference: "合成测试", purpose: "测试", retentionUntil: "2026-12-31" }

class MemoryJournal implements ProjectDeletionJournal {
  readonly directory = "memory"
  intents: ProjectDeletionIntent[] = []
  async readIntents(): Promise<ProjectDeletionIntent[]> { return this.intents.map(value => ({ ...value })) }
  async appendIntent(intent: ProjectDeletionIntent): Promise<void> {
    const existing = this.intents.find(value => value.projectId === intent.projectId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error("Conflicting project deletion journal")
      return
    }
    this.intents.push({ ...intent })
  }
}

type CallOptions = { method?: string; token?: string; origin?: string | null }
async function setup(options: { journalFailure?: boolean } = {}) {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  await applyProjectLifecycleSchema(database)
  const clock = new Date("2026-10-20T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const repository = new ProjectRepository(database, () => clock)
  const authorization = createProjectAuthorization({ repository, revalidateSession: access.revalidateAccountSession })
  const journal = new MemoryJournal()
  const deletion: ProjectDeletionPort = {
    async request({ projectId, actor, reason }) {
      const { project, record } = await repository.delete(projectId, actor, reason)
      if (options.journalFailure) throw new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。")
      await journal.appendIntent(journalIntentForRecord(record, project))
      return record
    },
  }
  const service = new ProjectService({ repository, authorization, now: () => clock, deletion })
  const handlers = createProjectHandlers(async () => ({ requireAccount: access.requireAccount, service, origin: () => site }))
  const call = (path: string, options: CallOptions = {}) => {
    const headers: Record<string, string> = {}
    if (options.token) headers.cookie = `__Host-equilens-auth=${options.token}`
    const method = options.method ?? "GET"
    if (method !== "GET") headers.origin = options.origin === null ? "" : options.origin ?? site
    return new Request(`${site}${path}`, { method, headers })
  }
  async function create(username: string) { await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" }) }
  async function login(username: string): Promise<{ token: string; identity: AuthIdentity }> {
    const result = await auth.login(username, password, "deployment")
    return { token: result.token, identity: await access.requireAccount(call("/workbench", { token: result.token })) }
  }
  return { database, auth, repository, service, handlers, journal, call, create, login }
}

async function expectJson(response: Response, status: number, code?: string): Promise<Record<string, unknown>> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const body = await response.json() as Record<string, unknown>
  if (code) assert.equal((body.error as { code?: string } | undefined)?.code, code)
  return body
}

test("C7 HTTP deletion: status is readable for the requester and superadmin, and only while member rows exist for other admins", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "carol", "root"]) await env.create(username)
    // Account maintenance revokes existing sessions, so grant before logging in.
    await env.auth.maintain({ action: "grant-admin", username: "root", actor: "synthetic-admin" })
    const alice = await env.login("alice"), bob = await env.login("bob"), carol = await env.login("carol"), root = await env.login("root")
    const created = await env.service.create(alice.identity, projectInput)
    const projectId = created.id
    await env.service.addMember(alice.identity, projectId, { username: "bob", role: "admin" })
    await env.service.addMember(alice.identity, projectId, { username: "carol", role: "viewer" })
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: alice.token }), context(projectId)), 404, "NOT_FOUND")
    assert.equal((await env.handlers.detail.DELETE(env.call(`/api/projects/${projectId}`, { method: "DELETE", token: alice.token }), context(projectId))).status, 204)
    const record = (await env.repository.deletionRecord(projectId)) as ProjectDeletionRecord
    assert.equal(record.state, "requested")
    assert.equal(env.journal.intents.length, 1)

    const requester = await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: alice.token }), context(projectId)), 200)
    assert.deepEqual(Object.keys(requester.deletion as Record<string, unknown>).sort(), ["attempts", "clearedAt", "completedAt", "requestedAt", "state"])
    assert.equal((requester.deletion as { state: string }).state, "requested")
    assert.equal(JSON.stringify(requester).includes("合成项目"), false, "no project content is exposed")
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: bob.token }), context(projectId)), 200)
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: root.token }), context(projectId)), 200)
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: carol.token }), context(projectId)), 404, "NOT_FOUND")

    // After the ordered row deletion removes membership rows, non-requester admins lose the read exception.
    await env.database.transaction(connection => connection.query("DELETE FROM equilens_project_members WHERE project_id=$1", [projectId]))
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: bob.token }), context(projectId)), 404, "NOT_FOUND")
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: alice.token }), context(projectId)), 200)
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`, { token: root.token }), context(projectId)), 200)
    // Anonymous/unauthenticated access is refused before deletion lookup.
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${projectId}/deletion`), context(projectId)), 401, "UNAUTHENTICATED")
  } finally { await env.database.close() }
})

test("C7 HTTP deletion: repeated DELETE is idempotent for the requester and refused for unrelated accounts", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "root"]) await env.create(username)
    await env.auth.maintain({ action: "grant-admin", username: "root", actor: "synthetic-admin" })
    const alice = await env.login("alice"), bob = await env.login("bob"), root = await env.login("root")
    const project = await env.service.create(alice.identity, projectInput)
    await env.service.addMember(alice.identity, project.id, { username: "bob", role: "editor" })
    assert.equal((await env.handlers.detail.DELETE(env.call(`/api/projects/${project.id}`, { method: "DELETE", token: alice.token }), context(project.id))).status, 204)
    const record = (await env.repository.deletionRecord(project.id)) as ProjectDeletionRecord
    assert.equal((await env.handlers.detail.DELETE(env.call(`/api/projects/${project.id}`, { method: "DELETE", token: alice.token }), context(project.id))).status, 204)
    assert.deepEqual(await env.repository.deletionRecord(project.id), record)
    assert.equal(env.journal.intents.length, 1)
    await expectJson(await env.handlers.detail.DELETE(env.call(`/api/projects/${project.id}`, { method: "DELETE", token: bob.token }), context(project.id)), 403, "FORBIDDEN")
    // A current superadmin may finish an interrupted delete request.
    assert.equal((await env.handlers.detail.DELETE(env.call(`/api/projects/${project.id}`, { method: "DELETE", token: root.token }), context(project.id))).status, 204)
  } finally { await env.database.close() }
})

test("C7 HTTP deletion: unavailable journal keeps the project revoked but returns 503 and deletion status stays observable", async () => {
  const env = await setup({ journalFailure: true })
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.service.create(alice.identity, projectInput)
    await expectJson(await env.handlers.detail.DELETE(env.call(`/api/projects/${project.id}`, { method: "DELETE", token: alice.token }), context(project.id)), 503, "SERVICE_UNAVAILABLE")
    assert.equal(await env.repository.findActive(project.id), null)
    const record = (await env.repository.deletionRecord(project.id)) as ProjectDeletionRecord
    assert.equal(record.state, "requested")
    await expectJson(await env.handlers.deletion.GET(env.call(`/api/projects/${project.id}/deletion`, { token: alice.token }), context(project.id)), 200)
  } finally { await env.database.close() }
})

test("C7 readiness gate: project DELETE and deletion status return 503 before the lifecycle runtime is ready", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.service.create(alice.identity, projectInput)
    const database = env.database
    const repository = new ProjectRepository(database)
    const authorization = createProjectAuthorization({ repository, revalidateSession: async () => alice.identity })
    const gated = new ProjectService({
      repository, authorization, ready: () => { throw new BusinessError("SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。") },
    })
    const handlers = createProjectHandlers(async () => ({ requireAccount: async () => alice.identity, service: gated, origin: () => site }))
    await expectJson(await handlers.detail.DELETE(new Request(`${site}/api/projects/${project.id}`, { method: "DELETE", headers: { origin: site } }), context(project.id)), 503, "SERVICE_UNAVAILABLE")
    await expectJson(await handlers.deletion.GET(new Request(`${site}/api/projects/${project.id}/deletion`), context(project.id)), 503, "SERVICE_UNAVAILABLE")
    await expectJson(await handlers.collection.GET(new Request(`${site}/api/projects`)), 503, "SERVICE_UNAVAILABLE")
    // Nothing was revoked while the runtime was not ready.
    assert.ok(await env.repository.findActive(project.id))
  } finally { await env.database.close() }
})
