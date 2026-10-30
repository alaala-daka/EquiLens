import assert from "node:assert/strict"
import { test } from "node:test"
import { createProjectPaymentsClient } from "./payments-client"

const value = { cutoff: "2026-10-30", rows: [], facts: [] }
const view = { resultId: "result-a", versionId: "version-a", kind: "payment-reconciliation", sha256: "a".repeat(64) }

test("payment client sends only draft fields through controlled new/revision routes", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  const client = createProjectPaymentsClient({ projectId: "project-a", isCurrent: () => true, canEdit: () => true, fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin")
    return Response.json(view)
  } })
  await client.save({ value, operationId: "same-operation", reason: "核对" })
  await client.save({ value, operationId: "revision-operation", reason: "补录", resultId: "result-a", baseVersionId: "version-a" })
  assert.equal(requests[0].url, "/api/projects/project-a/payments")
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["operationId", "reason", "value"])
  assert.equal(requests[1].url, "/api/projects/project-a/payments/result-a/revisions")
  assert.equal(requests[1].body.baseVersionId, "version-a")
})

test("payment client blocks viewers, preserves conflict errors, invalidates revoked access and drops late responses", async () => {
  let calls = 0
  const viewer = createProjectPaymentsClient({ projectId: "p", isCurrent: () => true, canEdit: () => false, fetch: async () => { calls++; return Response.json(view) } })
  await assert.rejects(viewer.save({ value, operationId: "op", reason: "核对" }), { code: "ACCESS_DENIED" }); assert.equal(calls, 0)
  let invalid = false, current = true
  const client = (status: number) => createProjectPaymentsClient({ projectId: "p", isCurrent: () => current, onAccessInvalid: () => { invalid = true }, fetch: async () => Response.json({ error: { code: status === 409 ? "CONFLICT" : "FORBIDDEN", message: "版本冲突" } }, { status }) })
  await assert.rejects(client(409).save({ value, operationId: "op", reason: "核对" }), { code: "CONFLICT" }); assert.equal(invalid, false)
  await assert.rejects(client(403).save({ value, operationId: "op", reason: "核对" }), { code: "ACCESS_DENIED" }); assert.equal(invalid, true)
  const late = createProjectPaymentsClient({ projectId: "p", isCurrent: () => current, fetch: async () => { current = false; return Response.json(view) } })
  await assert.rejects(late.save({ value, operationId: "op", reason: "核对" }), { code: "ABORTED" })
})
