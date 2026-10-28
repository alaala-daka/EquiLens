import assert from "node:assert/strict"
import test from "node:test"
import { accountEntryState } from "./account-entry"
const session = { user: { id: "synthetic", username: "operator", role: "member" as const }, expiresAt: "2026-10-28T00:00:00.000Z" }
test("valid session shows the account name", () => {
  assert.deepEqual(accountEntryState({ ok: true, session }), { kind: "signed-in", username: "operator" })
})
test("only 401 means anonymous; network and server failures stay unavailable", () => {
  assert.deepEqual(accountEntryState({ ok: false, status: 401 }), { kind: "anonymous" })
  for (const status of [0, 403, 500, 503]) assert.deepEqual(accountEntryState({ ok: false, status }), { kind: "unavailable" })
})
