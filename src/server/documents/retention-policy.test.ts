import assert from "node:assert/strict"
import { test } from "node:test"
import { retentionExpiry, retentionPolicy, sessionAccess, type StoredAnonymousSession } from "./retention-policy"

const policy = { days: 2, version: "anonymous-v1:2" }
const record: StoredAnonymousSession = {
  owner: "synthetic-owner", contextId: "synthetic-context", firstCreatedAt: "2026-10-22T00:00:00Z",
  retentionDays: 2, expiresAt: "2026-10-24T00:00:00.000Z", policyVersion: policy.version,
  exportUntil: null, legacyPending: false, revision: 1, revokedAt: null, registration: null,
}
const at = (time: string, changes: Partial<StoredAnonymousSession> = {}, currentPolicy: typeof policy | null = policy) =>
  sessionAccess({ ...record, ...changes }, new Date(time), currentPolicy)

test("DB-08: retention has no fallback and accepts only safe positive decimal integers", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "Infinity", " 2 ", "02", "2e1", "9007199254740992", "104249992"]) {
    assert.throws(() => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: value }))
  }
  assert.deepEqual(retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }), policy)
  assert.equal(retentionExpiry(record.firstCreatedAt!, 2), record.expiresAt)
  assert.throws(() => retentionExpiry("invalid", 2))
  assert.throws(() => retentionExpiry("+275760-09-13T00:00:00.000Z", 2))
})

test("DB-08: ordinary expiry denies access exactly at deadline", () => {
  const before = at("2026-10-23T23:59:59.999Z")
  assert.equal(before.state, "active")
  assert.equal(before.canRead && before.canSave && before.canCreate, true)
  for (const time of ["2026-10-24T00:00:00.000Z", "2026-10-24T00:00:00.001Z"]) {
    const view = at(time)
    assert.equal(view.state, "expired")
    assert.equal(view.canRead || view.canSave || view.canCreate, false)
    assert.equal(view.canRestart, true)
    assert.equal(view.issue?.code, "RETENTION_EXPIRED")
  }
})

test("DB-08: legacy window permits only reading and ends at its exact boundary", () => {
  const changes = { exportUntil: "2026-10-25T00:00:00.000Z" }
  for (const time of ["2026-10-24T00:00:00.000Z", "2026-10-24T23:59:59.999Z"]) {
    const view = at(time, changes)
    assert.equal(view.state, "legacy_export")
    assert.equal(view.canRead, true)
    assert.equal(view.canSave || view.canCreate || view.canRestart, false)
    assert.equal(view.confirmation, null)
  }
  for (const time of ["2026-10-25T00:00:00.000Z", "2026-10-25T00:00:00.001Z"]) {
    assert.equal(at(time, changes).state, "expired")
  }
})

test("DB-08: missing configuration preserves registered read/save without allowing creation or restart", () => {
  const view = at("2026-10-23T00:00:00Z", {}, null)
  assert.equal(view.canRead && view.canSave, true)
  assert.equal(view.canCreate, false)
  assert.equal(view.issue?.code, "RETENTION_UNCONFIGURED")
  assert.equal(at("2026-10-24T00:00:00Z", {}, null).canRestart, false)
  assert.equal(at("2026-10-23T00:00:00Z", {}, { days: 3, version: "anonymous-v1:3" }).expiresAt, record.expiresAt)
  assert.equal(view.confirmation?.policyVersion, policy.version)
})

test("DB-08: revocation and pending registration take precedence", () => {
  const pending = at("2026-10-23T00:00:00Z", { legacyPending: true })
  assert.equal(pending.state, "legacy_pending")
  assert.equal(pending.canRead || pending.canSave || pending.canCreate || pending.canRestart, false)
  const revoked = at("2026-10-23T00:00:00Z", { legacyPending: true, revokedAt: "2026-10-22T12:00:00Z" })
  assert.equal(revoked.state, "expired")
})

test("DB-08: new confirmation uses supplied time and Shanghai date without fixing expiry", () => {
  const empty = { firstCreatedAt: null, retentionDays: null, expiresAt: null, policyVersion: null }
  const view = at("2026-10-22T16:00:00Z", empty)
  assert.equal(view.state, "new")
  assert.equal(view.expiresAt, null)
  assert.deepEqual(view.confirmation, { contextId: record.contextId, policyVersion: policy.version, expiresOn: "2026-10-25" })
  const missing = at("2026-10-22T16:00:00Z", empty, null)
  assert.equal(missing.canCreate, false)
  assert.equal(missing.confirmation, null)
})
