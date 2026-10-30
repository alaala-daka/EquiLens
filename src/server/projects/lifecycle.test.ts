import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createAccountAccess } from "../auth/handlers"
import { authConfig } from "../auth/config"
import { AuthService, type AuthIdentity } from "../auth/service"
import { createSyntheticObjectStore } from "../storage/obs"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { createProjectAuthorization, createTaskExecutionAuthorization } from "./authorization"
import { createProjectDeletionJournal, type ProjectDeletionIntent, type ProjectDeletionJournal } from "./deletion-journal"
import { applyProjectLifecycleSchema, type ProjectDeletionRecord } from "./lifecycle-schema"
import { journalIntentForRecord, reclaimProject, reconcileRecordlessDeletedProjects } from "./reclamation"
import { ProjectRepository } from "./repository"
import { applyProjectSchema } from "./schema"
import { ProjectService, type ProjectDeletionPort } from "./service"

const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const cookieRequest = (token: string) => new Request(`${site}/workbench`, { headers: { cookie: `__Host-equilens-auth=${token}` } })
const password = "Synthetic password 123!"

class MemoryJournal implements ProjectDeletionJournal {
  readonly directory = "memory"
  readonly intents: ProjectDeletionIntent[] = []
  async readIntents(): Promise<ProjectDeletionIntent[]> { return this.intents.map(value => ({ ...value })) }
  async appendIntent(intent: ProjectDeletionIntent): Promise<void> {
    const existing = this.intents.find(value => value.projectId === intent.projectId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error("Conflicting project deletion journal")
      return
    }
    if (this.intents.some(value => value.id === intent.id)) throw new Error("Conflicting project deletion journal")
    this.intents.push({ ...intent })
  }
}

type Environment = {
  database: Database
  auth: AuthService
  access: ReturnType<typeof createAccountAccess>
  repository: ProjectRepository
  service: ProjectService
  journal: MemoryJournal
  setNow(value: string): void
  create(username: string): Promise<void>
  login(username: string): Promise<{ token: string; identity: AuthIdentity }>
  close(): Promise<void>
}

async function setup(): Promise<Environment> {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  await applyProjectLifecycleSchema(database)
  let clock = new Date("2026-10-20T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const repository = new ProjectRepository(database, () => clock)
  const authorization = createProjectAuthorization({ repository, revalidateSession: access.revalidateAccountSession })
  const journal = new MemoryJournal()
  const deletion: ProjectDeletionPort = {
    async request({ projectId, actor, reason }) {
      const { project, record } = await repository.delete(projectId, actor, reason)
      await journal.appendIntent(journalIntentForRecord(record, project))
      return record
    },
  }
  const service = new ProjectService({ repository, authorization, now: () => clock, deletion })
  return {
    database, auth, access, repository, service, journal,
    setNow(value: string) { clock = new Date(value) },
    async create(username) { await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" }) },
    async login(username) {
      const result = await auth.login(username, password, "deployment")
      return { token: result.token, identity: await access.requireAccount(cookieRequest(result.token)) }
    },
    async close() { await database.close() },
  }
}

const projectInput = { name: "合成项目", source: "authorized" as const, sourceReference: "合成测试授权", purpose: "测试", retentionUntil: "2026-10-28" }
const syntheticInput = { name: "合成比赛项目", source: "synthetic" as const, sourceReference: "合成测试", purpose: "演示", retentionUntil: "2026-10-28" }

async function seeded(env: Environment, input: typeof projectInput = projectInput, now = "2026-10-20T00:00:00.000Z") {
  env.setNow(now)
  await env.create("alice")
  const alice = await env.login("alice")
  const project = await env.service.create(alice.identity, input)
  return { alice, project }
}

test("C7 retention: expired authorized projects are denied on every request before any sweep", async () => {
  const env = await setup()
  try {
    // Login is inside the 12h session window; the retention day ends at
    // 2026-10-21T16:00:00Z (Asia/Shanghai next-day midnight).
    const { alice, project } = await seeded(env, { ...projectInput, retentionUntil: "2026-10-21" }, "2026-10-21T10:00:00.000Z")
    assert.equal((await env.service.detail(alice.identity, project.id)).id, project.id)
    env.setNow("2026-10-21T15:59:59.999Z")
    assert.equal((await env.service.detail(alice.identity, project.id)).id, project.id)
    env.setNow("2026-10-21T16:00:00.000Z")
    assert.deepEqual((await env.service.list(alice.identity)).projects, [])
    await assert.rejects(env.service.detail(alice.identity, project.id), { code: "FORBIDDEN" })
    assert.equal(await env.repository.findActive(project.id), null)
    assert.equal(await env.repository.findMember(project.id, alice.identity.account.id), null)
    // Background task authorization re-reads the same derived state.
    const execution = createTaskExecutionAuthorization({
      account: id => env.auth.account(id),
      repository: { findActive: id => env.repository.findActive(id), findMember: (id, accountId) => env.repository.findMember(id, accountId) },
    })
    await assert.rejects(execution.authorize({ accountId: alice.identity.account.id, projectId: project.id, action: "read" }), { code: "FORBIDDEN" })
    // The hourly sweep only performs cleanup; no deletion record exists yet.
    assert.equal(await env.repository.deletionRecord(project.id), null)
  } finally { await env.close() }
})

test("C7 retention: synthetic projects never auto-expire and can still be explicitly deleted", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.service.create(alice.identity, syntheticInput)
    env.setNow("2027-06-01T00:00:00Z")
    // A fresh login is needed after the clock jump; retention must not deny it.
    const later = await env.login("alice")
    assert.equal((await env.service.detail(later.identity, project.id)).id, project.id)
    assert.deepEqual((await env.service.list(later.identity)).projects.map(item => item.id), [project.id])
    assert.deepEqual(await env.repository.listExpiredAuthorized(new Date("2027-06-01T00:00:00Z")), [])
    await env.service.remove(later.identity, project.id)
    assert.equal((await env.repository.deletionRecord(project.id))?.state, "requested")
  } finally { await env.close() }
})

test("C7 retention: the sweep selects only expired authorized projects", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const authorized = await env.service.create(alice.identity, projectInput)
    await env.service.create(alice.identity, syntheticInput)
    const expired = await env.repository.listExpiredAuthorized(new Date("2026-10-30T00:00:00Z"), 10)
    assert.deepEqual(expired.map(item => item.id), [authorized.id])
    assert.deepEqual(await env.repository.listExpiredAuthorized(new Date("2026-10-20T00:00:00Z"), 10), [])
  } finally { await env.close() }
})

test("C7 delete: access revocation and the deletion record commit in one transaction, then the journal", async () => {
  const env = await setup()
  try {
    const { alice, project } = await seeded(env)
    await env.service.remove(alice.identity, project.id)
    const record = (await env.repository.deletionRecord(project.id)) as ProjectDeletionRecord
    assert.equal(record.state, "requested")
    assert.equal(record.reason, "user-delete")
    assert.equal(record.requestedBy, alice.identity.account.id)
    assert.equal(record.retentionUntil, "2026-10-28")
    assert.equal(record.attempts, 0)
    const raw = (await env.database.transaction(connection => connection.query("SELECT status,deleted_at FROM equilens_projects WHERE id=$1", [project.id]))).rows[0]
    assert.equal(raw.status, "deleted")
    assert.ok(raw.deleted_at)
    assert.equal(env.journal.intents.length, 1)
    assert.equal(env.journal.intents[0].id, record.intentId)
    assert.deepEqual(env.journal.intents[0], { version: 1, id: record.intentId, projectId: project.id, reason: "user-delete", requestedBy: alice.identity.account.id, requestedAt: record.requestedAt, retentionUntil: "2026-10-28" })
    const audit = (await env.database.transaction(connection => connection.query("SELECT action FROM equilens_project_audit WHERE project_id=$1 ORDER BY created_at", [project.id]))).rows
    assert.equal(audit.some(row => row.action === "project.delete"), true)
    // Access is revoked immediately.
    await assert.rejects(env.service.detail(alice.identity, project.id), { code: "FORBIDDEN" })
    assert.deepEqual((await env.service.list(alice.identity)).projects, [])
    // Repeated delete is idempotent: no second record/intent.
    await env.service.remove(alice.identity, project.id)
    assert.deepEqual(await env.repository.deletionRecord(project.id), record)
    assert.equal(env.journal.intents.length, 1)
  } finally { await env.close() }
})

test("C7 delete: a non-admin cannot delete; unknown projects stay NOT_FOUND", async () => {
  const env = await setup()
  try {
    const { alice, project } = await seeded(env)
    await env.create("bob")
    const bob = await env.login("bob")
    await env.service.addMember(alice.identity, project.id, { username: "bob", role: "editor" })
    await assert.rejects(env.service.remove(bob.identity, project.id), { code: "FORBIDDEN" })
    assert.equal((await env.repository.deletionRecord(project.id)), null)
    // Unknown project ids share the non-member refusal (no existence leak).
    await assert.rejects(env.service.remove(alice.identity, "99999999-9999-4999-8999-999999999999"), { code: "FORBIDDEN" })
  } finally { await env.close() }
})

test("C7 reconcile: legacy deleted-without-record projects get a record + journal and are reclaimed, never re-activated", async () => {
  const env = await setup()
  try {
    const { project, alice } = await seeded(env)
    // Simulate a pre-C7 delete: status flipped with no deletion record/journal.
    await env.database.transaction(connection => connection.query("UPDATE equilens_projects SET status='deleted',deleted_at=$1,updated_at=$2 WHERE id=$3", ["2026-10-21T00:00:00.000Z", "2026-10-21T00:00:00.000Z", project.id]))
    assert.equal(await env.repository.deletionRecord(project.id), null)
    assert.deepEqual((await env.repository.listRecordlessDeleted()).map(item => item.id), [project.id])
    const result = await reconcileRecordlessDeletedProjects(env.database, env.journal, {
      store: createSyntheticObjectStore(), now: () => new Date("2026-10-22T00:00:00.000Z"), batch: 10,
    })
    assert.equal(result.reconciled, 1)
    assert.equal(result.failed, 0)
    const record = (await env.repository.deletionRecord(project.id)) as ProjectDeletionRecord
    assert.equal(record.state, "reclaimed")
    assert.equal(record.requestedBy, "system:reconcile")
    assert.equal(record.reason, "admin-remove")
    assert.ok(record.completedAt)
    assert.equal(env.journal.intents.length, 1)
    assert.equal((await env.database.transaction(connection => connection.query("SELECT status FROM equilens_projects WHERE id=$1", [project.id]))).rows[0].status, "deleted")
    await assert.rejects(env.service.detail(alice.identity, project.id), { code: "FORBIDDEN" })
    // Members/audit rows are part of the ordered row deletion.
    assert.equal((await env.database.transaction(connection => connection.query("SELECT COUNT(*) AS count FROM equilens_project_members WHERE project_id=$1", [project.id]))).rows[0].count, 0)
  } finally { await env.close() }
})

test("C7 delete: a journal failure does not restore access and keeps the request retryable", async () => {
  const env = await setup()
  try {
    const { alice, project } = await seeded(env)
    const failing: ProjectDeletionPort = {
      async request({ projectId, actor, reason }) {
        const { record } = await env.repository.delete(projectId, actor, reason)
        // Journal unavailable: the project is already access-revoked and stays requested.
        throw new Error(`synthetic journal failure ${record.id}`)
      },
    }
    const service = new ProjectService({ repository: env.repository, authorization: createProjectAuthorization({ repository: env.repository, revalidateSession: env.access.revalidateAccountSession }), now: () => new Date("2026-10-20T00:00:00Z"), deletion: failing })
    await assert.rejects(service.remove(alice.identity, project.id))
    assert.equal((await env.repository.deletionRecord(project.id))?.state, "requested")
    await assert.rejects(env.service.detail(alice.identity, project.id), { code: "FORBIDDEN" })
    assert.equal(env.journal.intents.length, 0)
  } finally { await env.close() }
})

test("C7 retention sweep: only expired authorized projects are revoked (system:retention) and reclaimed; synthetic stays", async () => {
  const env = await setup()
  try {
    const { project } = await seeded(env, { ...projectInput, retentionUntil: "2026-10-21" }, "2026-10-21T10:00:00.000Z")
    await env.service.create((await env.login("alice")).identity, syntheticInput)
    env.setNow("2026-10-22T00:00:00.000Z")
    const now = new Date("2026-10-22T00:00:00.000Z")
    const candidates = await env.repository.listExpiredAuthorized(now, 10)
    assert.deepEqual(candidates.map(item => item.id), [project.id])
    const store = createSyntheticObjectStore()
    for (const candidate of candidates) {
      // The sweep surface: revoke + record first, then durable journal, then reclaim.
      const { project: revoked, record } = await env.repository.delete(candidate.id, "system:retention", "retention-expired")
      assert.equal(record.requestedBy, "system:retention")
      assert.equal(record.reason, "retention-expired")
      await env.journal.appendIntent(journalIntentForRecord(record, revoked))
      const outcome = await reclaimProject(env.database, candidate.id, { journal: env.journal, store, now: () => now })
      assert.equal(outcome.state, "reclaimed")
    }
    const record = (await env.repository.deletionRecord(project.id)) as ProjectDeletionRecord
    assert.equal(record.state, "reclaimed")
    assert.equal(record.requestedBy, "system:retention")
    // Synthetic project is never auto-selected and remains active.
    const remaining = await env.repository.listFor("00000000-0000-4000-8000-000000000001", true)
    assert.equal(remaining.length, 1)
    const synthetic = (await env.database.transaction(connection => connection.query("SELECT status FROM equilens_projects WHERE source='synthetic'"))).rows
    assert.deepEqual(synthetic.map(row => row.status), ["active"])
  } finally { await env.close() }
})

test("C7 journal factory: a directory journal keeps one intent per deleted project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-lifecycle-"))
  try {
    const journal = createProjectDeletionJournal(directory, { async openDirectory() { return { async sync() {}, async close() {} } } })
    const intent: ProjectDeletionIntent = { version: 1, id: "22222222-2222-4222-8222-222222222222", projectId: "11111111-1111-4111-8111-111111111111", reason: "retention-expired", requestedBy: "system:retention", requestedAt: "2026-10-30T00:00:00.000Z", retentionUntil: "2026-10-30" }
    await journal.appendIntent(intent)
    await journal.appendIntent(intent)
    assert.deepEqual(await journal.readIntents(), [intent])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
