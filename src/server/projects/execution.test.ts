import assert from "node:assert/strict"
import { test } from "node:test"
import { createTaskExecutionAuthorization } from "./authorization"
import { AuthService } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"

const projectId = "11111111-1111-4111-8111-111111111111"

test("C1b: enabled account lookup survives logout and reflects disable/role maintenance", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await migrateBusiness(database)
    const auth = new AuthService(database)
    const created = await auth.maintain({ action: "create", username: "synthetic", password: "Synthetic password 123!", actor: "test" })
    const login = await auth.login("synthetic", "Synthetic password 123!", "test")
    await auth.logout(login.token)
    assert.equal((await auth.account(created.id))?.role, "member")
    await auth.maintain({ action: "grant-admin", username: "synthetic", actor: "test" })
    assert.equal((await auth.account(created.id))?.role, "superadmin")
    await auth.maintain({ action: "disable", username: "synthetic", actor: "test" })
    assert.equal(await auth.account(created.id), null)
    assert.equal(await auth.account("missing"), null)
  } finally { await database.close() }
})

test("C1b/AC-15: background access reads fresh account and membership without a session", async () => {
  let enabled = true
  let active = true
  let role: "editor" | "viewer" | null = "editor"
  let superadmin = false
  const guard = createTaskExecutionAuthorization({
    account: async id => enabled && id === "account" ? { id, username: "synthetic", role: superadmin ? "superadmin" : "member" } : null,
    repository: { findActive: async () => active ? { id: projectId } : null, findMember: async () => active ? role : null },
  })
  const input = { accountId: "account", projectId, action: "edit" as const }
  assert.equal((await guard.authorize(input)).role, "editor")
  role = "viewer"
  await assert.rejects(guard.authorize(input), { code: "FORBIDDEN" })
  assert.equal((await guard.authorize({ ...input, action: "read" })).role, "viewer")
  role = null
  await assert.rejects(guard.authorize(input), { code: "FORBIDDEN" })
  superadmin = true
  assert.equal((await guard.authorize(input)).role, "admin")
  active = false
  await assert.rejects(guard.authorize(input), { code: "FORBIDDEN" })
  active = true
  enabled = false
  await assert.rejects(guard.authorize(input), { code: "FORBIDDEN" })
  await assert.rejects(guard.authorize({ ...input, projectId: "unknown" }), { code: "FORBIDDEN" })
})

test("C1b: database failures remain unavailable instead of authorization denial", async () => {
  const guard = createTaskExecutionAuthorization({
    account: async () => { throw new Error("private database detail") },
    repository: { findActive: async () => null, findMember: async () => null },
  })
  await assert.rejects(guard.authorize({ accountId: "account", projectId, action: "read" }), {
    code: "SERVICE_UNAVAILABLE", message: "服务暂不可用，请稍后重试。",
  })
})
