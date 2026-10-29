import assert from "node:assert/strict"
import { test } from "node:test"
import { createAccountAccess } from "../auth/handlers"
import { authConfig } from "../auth/config"
import { AuthService, type AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { createProjectAuthorization, roleAllows } from "./authorization"
import { ProjectRepository } from "./repository"
import { applyProjectSchema } from "./schema"
import { ProjectService } from "./service"
import type { ProjectCreateInput } from "./types"

const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const cookieRequest = (token: string) => new Request(`${site}/workbench`, { headers: { cookie: `__Host-equilens-auth=${token}` } })
const password = "Synthetic password 123!"
const project: ProjectCreateInput = {
  name: "房建机电安装专业分包项目",
  source: "synthetic",
  sourceReference: "合成比赛项目",
  purpose: "合同审查与款项核对",
  retentionUntil: "2027-01-31",
}

async function setup() {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  let clock = new Date("2026-10-28T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const repository = new ProjectRepository(database, () => clock)
  const authorization = createProjectAuthorization({ repository, revalidateSession: access.revalidateAccountSession })
  const service = new ProjectService({ repository, authorization, now: () => clock })
  async function create(username: string) {
    await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" })
  }
  async function login(username: string): Promise<{ token: string; identity: AuthIdentity }> {
    const result = await auth.login(username, password, "deployment")
    return { token: result.token, identity: await access.requireAccount(cookieRequest(result.token)) }
  }
  async function logout(token: string) {
    await auth.logout(token)
  }
  return { database, auth, access, repository, authorization, service, create, login, logout, advance: (value: Date) => { clock = value } }
}

test("C1/AC-15: three project roles, cross-project denial and immediate revocation", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "carol"]) await env.create(username)
    const alice = await env.login("alice")
    const created = await env.service.create(alice.identity, project)
    assert.equal(created.role, "admin")
    assert.deepEqual((await env.service.list(alice.identity)).projects.map(value => [value.id, value.role]), [[created.id, "admin"]])

    const bob = await env.login("bob")
    const carol = await env.login("carol")
    await env.service.addMember(alice.identity, created.id, { username: "bob", role: "editor" })
    await env.service.addMember(alice.identity, created.id, { username: "carol", role: "viewer" })

    assert.equal((await env.service.detail(bob.identity, created.id)).role, "editor")
    assert.equal((await env.service.detail(carol.identity, created.id)).role, "viewer")
    assert.equal((await env.service.members(alice.identity, created.id)).length, 3)
    await assert.rejects(env.service.members(carol.identity, created.id), { code: "FORBIDDEN" })

    // Capability matrix is enforced by the shared guard, not by browser controls.
    assert.equal((await env.authorization.requireProjectAccess(alice.identity, created.id, "manage")).role, "admin")
    assert.equal((await env.authorization.requireProjectAccess(bob.identity, created.id, "edit")).role, "editor")
    await assert.rejects(env.authorization.requireProjectAccess(carol.identity, created.id, "edit"), { code: "FORBIDDEN" })
    await assert.rejects(env.authorization.requireProjectAccess(bob.identity, created.id, "manage"), { code: "FORBIDDEN" })

    // A viewer cannot write project settings or membership.
    await assert.rejects(env.service.update(carol.identity, created.id, { name: "只读改名" }), { code: "FORBIDDEN" })
    await assert.rejects(env.service.addMember(carol.identity, created.id, { username: "dave", role: "viewer" }), { code: "FORBIDDEN" })
    await assert.rejects(env.service.update(bob.identity, created.id, { name: "编辑改名" }), { code: "FORBIDDEN" })
    assert.equal((await env.service.update(alice.identity, created.id, { name: "合同审查项目 2026" })).name, "合同审查项目 2026")

    // Removing membership revokes the next request even for an identity snapshot.
    await env.service.removeMember(alice.identity, created.id, (await env.service.members(alice.identity, created.id)).find(member => member.username === "carol")!.accountId)
    await assert.rejects(env.service.detail(carol.identity, created.id), { code: "FORBIDDEN" })
    await assert.rejects(env.authorization.requireProjectAccess(carol.identity, created.id, "read"), { code: "FORBIDDEN" })
    assert.deepEqual((await env.service.list(carol.identity)).projects, [])

    // Logout invalidates the session before membership is consulted.
    await env.logout(carol.token)
    await assert.rejects(env.authorization.requireProjectAccess(carol.identity, created.id, "read"), { code: "UNAUTHENTICATED" })
    await assert.rejects(env.service.list(carol.identity), { code: "UNAUTHENTICATED" })

    // Deleting the project hides and denies it for members and the superadmin exception alike.
    await env.service.remove(alice.identity, created.id)
    await assert.rejects(env.service.detail(bob.identity, created.id), { code: "FORBIDDEN" })
    assert.deepEqual((await env.service.list(alice.identity)).projects, [])
  } finally {
    await env.database.close()
  }
})

test("C1/AC-15: cross-project IDs, new accounts and superadmin scope", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "carol", "eve", "root"]) await env.create(username)
    const alice = await env.login("alice")
    const bob = await env.login("bob")
    const carol = await env.login("carol")
    const eve = await env.login("eve")
    const first = await env.service.create(alice.identity, project)
    const second = await env.service.create(bob.identity, { ...project, name: "第二项目" })
    await env.service.addMember(alice.identity, first.id, { username: "carol", role: "viewer" })

    // Cross-project resource IDs are refused; unknown IDs are indistinguishable for non-members.
    await assert.rejects(env.service.detail(alice.identity, second.id), { code: "FORBIDDEN" })
    await assert.rejects(env.service.detail(bob.identity, first.id), { code: "FORBIDDEN" })
    await assert.rejects(env.service.detail(carol.identity, second.id), { code: "FORBIDDEN" })
    await assert.rejects(env.service.detail(alice.identity, "00000000-0000-4000-8000-000000000000"), { code: "FORBIDDEN" })

    // A new account has no project membership from account maintenance.
    assert.deepEqual(await env.service.list(eve.identity), { projects: [], canCreateProject: true })
    await assert.rejects(env.service.detail(eve.identity, first.id), { code: "FORBIDDEN" })
    await assert.rejects(env.authorization.requireProjectAccess(eve.identity, first.id, "read"), { code: "FORBIDDEN" })

    // Superadmin is a global exception that still needs a real project.
    await env.auth.maintain({ action: "grant-admin", username: "root", actor: "synthetic-operator" })
    const promoted = await env.login("root")
    assert.equal(promoted.identity.account.role, "superadmin")
    assert.equal((await env.authorization.requireProjectAccess(promoted.identity, first.id, "manage")).role, "admin")
    assert.equal((await env.service.detail(promoted.identity, second.id)).role, "admin")
    assert.deepEqual((await env.service.list(promoted.identity)).projects.map(value => value.id).sort(), [first.id, second.id].sort())
    await assert.rejects(env.service.detail(promoted.identity, "00000000-0000-4000-8000-000000000000"), { code: "NOT_FOUND" })
    await assert.rejects(env.authorization.requireProjectAccess(promoted.identity, "not-a-project", "read"), { code: "NOT_FOUND" })
  } finally {
    await env.database.close()
  }
})

test("C1: membership management keeps an admin, rejects duplicates and disabled accounts", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "carol"]) await env.create(username)
    const alice = await env.login("alice")
    const bob = await env.login("bob")
    const created = await env.service.create(alice.identity, project)

    await assert.rejects(env.service.changeRole(alice.identity, created.id, alice.identity.account.id, { role: "editor" }), { code: "CONFLICT", message: "项目至少保留一名管理员。" })
    await assert.rejects(env.service.removeMember(alice.identity, created.id, alice.identity.account.id), { code: "CONFLICT" })
    await env.service.addMember(alice.identity, created.id, { username: "bob", role: "admin" })
    // With two admins the creator may demote or remove herself, but the project still keeps one admin.
    const demoted = await env.service.changeRole(alice.identity, created.id, bob.identity.account.id, { role: "editor" })
    assert.equal(demoted.role, "editor")
    await assert.rejects(env.service.removeMember(alice.identity, created.id, alice.identity.account.id), { code: "CONFLICT" })
    await env.service.changeRole(alice.identity, created.id, bob.identity.account.id, { role: "admin" })
    await env.service.removeMember(alice.identity, created.id, alice.identity.account.id)
    await assert.rejects(env.service.detail(alice.identity, created.id), { code: "FORBIDDEN" })

    // bob is now the only admin and cannot demote or remove himself.
    await assert.rejects(env.service.changeRole(bob.identity, created.id, bob.identity.account.id, { role: "editor" }), { code: "CONFLICT" })
    await assert.rejects(env.service.removeMember(bob.identity, created.id, bob.identity.account.id), { code: "CONFLICT" })

    await assert.rejects(env.service.addMember(bob.identity, created.id, { username: "bob", role: "viewer" }), { code: "CONFLICT", message: "该账号已是项目成员。" })
    await assert.rejects(env.service.addMember(bob.identity, created.id, { username: "nobody", role: "viewer" }), { code: "NOT_FOUND", message: "找不到该账号。" })
    await env.auth.maintain({ action: "disable", username: "carol", actor: "synthetic-admin" })
    await assert.rejects(env.service.addMember(bob.identity, created.id, { username: "carol", role: "viewer" }), { code: "CONFLICT", message: "该账号不可用。" })
    await assert.rejects(env.service.changeRole(bob.identity, created.id, "00000000-0000-4000-8000-000000000000", { role: "viewer" }), { code: "NOT_FOUND" })
    await assert.rejects(env.service.changeRole(bob.identity, created.id, bob.identity.account.id, { role: "owner" }), { code: "INVALID_INPUT" })
    await assert.rejects(env.service.addMember(bob.identity, created.id, { username: "bo", role: "viewer" }), { code: "INVALID_INPUT" })

    const audit = (await env.database.transaction(connection =>
      connection.query("SELECT action FROM equilens_project_audit WHERE project_id=$1 ORDER BY action", [created.id]))).rows.map(row => String(row.action))
    for (const action of ["member.add", "member.remove", "member.update", "project.create"]) assert.ok(audit.includes(action), action)
  } finally {
    await env.database.close()
  }
})

test("C1: concurrent membership changes cannot drop the last project administrator", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob"]) await env.create(username)
    const alice = await env.login("alice")
    const bob = await env.login("bob")
    const created = await env.service.create(alice.identity, project)
    await env.service.addMember(alice.identity, created.id, { username: "bob", role: "admin" })
    const results = await Promise.allSettled([
      env.service.changeRole(alice.identity, created.id, bob.identity.account.id, { role: "editor" }),
      env.service.removeMember(bob.identity, created.id, alice.identity.account.id),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const admins = (await env.database.transaction(connection =>
      connection.query("SELECT account_id FROM equilens_project_members WHERE project_id=$1 AND role='admin'", [created.id]))).rows
    assert.equal(admins.length, 1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    assert.ok(["CONFLICT", "FORBIDDEN"].includes((rejected.reason as { code?: string }).code ?? ""))
  } finally {
    await env.database.close()
  }
})

test("C1: project creation validates source authorization, purpose and retention", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const invalidInputs: unknown[] = [
      { ...project, name: "  " },
      { ...project, purpose: "" },
      { ...project, source: "public" },
      { ...project, sourceReference: "" },
      { ...project, retentionUntil: "2026-02-31" },
      { ...project, retentionUntil: "2026-10-27" },
      { ...project, retentionUntil: "2027/01/31" },
      { ...project, name: "x".repeat(121) },
      { ...project, extra: "no" },
    ]
    for (const input of invalidInputs) await assert.rejects(env.service.create(alice.identity, input), { code: "INVALID_INPUT" })
    await assert.rejects(env.service.create(alice.identity, null), { code: "INVALID_INPUT" })

    const created = await env.service.create(alice.identity, { ...project, retentionUntil: "2026-10-28" })
    const stored = (await env.database.transaction(connection => connection.query("SELECT source,source_reference,purpose,retention_until,status FROM equilens_projects WHERE id=$1", [created.id]))).rows[0]
    assert.deepEqual({ ...stored }, { source: "synthetic", source_reference: "合成比赛项目", purpose: "合同审查与款项核对", retention_until: "2026-10-28", status: "active" })
    assert.equal(created.role, "admin")
    if ("sourceReference" in created) assert.fail("source reference must not leak through the summary contract")

    await assert.rejects(env.service.update(alice.identity, created.id, {}), { code: "INVALID_INPUT" })
    const updated = await env.service.update(alice.identity, created.id, { purpose: "投标核验", retentionUntil: "2027-06-30" })
    assert.equal(updated.purpose, "投标核验")
    assert.equal(updated.retentionUntil, "2027-06-30")
  } finally {
    await env.database.close()
  }
})

test("C1: roleAllows is the single three-role capability matrix", () => {
  assert.deepEqual(
    ["admin", "editor", "viewer"].map(role => ["read", "edit", "manage"].map(action => roleAllows(role as "admin", action as "read"))),
    [[true, true, true], [true, true, false], [true, false, false]],
  )
})

test("C1: disabled account and closed storage fail closed without disguising auth state", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const created = await env.service.create(alice.identity, project)
    await env.auth.maintain({ action: "disable", username: "alice", actor: "synthetic-operator" })
    await assert.rejects(env.service.detail(alice.identity, created.id), { code: "UNAUTHENTICATED" })
    await assert.rejects(env.authorization.requireProjectAccess(alice.identity, created.id, "read"), { code: "UNAUTHENTICATED" })
  } finally {
    await env.database.close()
  }
})
