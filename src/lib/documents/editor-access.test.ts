import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentSessionError, preflightEditorAccess, setDocumentContext } from "./client"

test("DB-08: cached export and serialization preflight check capabilities then actual resource access", async t => {
  setDocumentContext("fixture-context")
  let allowed = true
  let canCreate = true
  let changed = false
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url))
    if (url === "/api/document-session") return Response.json({
      contextId: changed ? "other-context" : "fixture-context", canSave: allowed, canCreate,
      issue: allowed ? undefined : { code: "RETENTION_EXPIRED", message: "已到期" },
    })
    return Response.json({ error: "已到期", code: "RETENTION_EXPIRED" }, { status: 410 })
  })
  // The resource request is required even after a successful session view.
  await assert.rejects(preflightEditorAccess("fixture-document"), DocumentSessionError)
  assert.deepEqual(calls, ["/api/document-session", "/api/documents/fixture-document"])
  calls.length = 0; allowed = false
  await assert.rejects(preflightEditorAccess("fixture-document"), DocumentSessionError)
  assert.deepEqual(calls, ["/api/document-session"])
  calls.length = 0; allowed = true; canCreate = false
  await assert.rejects(preflightEditorAccess("fixture-document", { copy: true }), DocumentSessionError)
  assert.deepEqual(calls, ["/api/document-session"])
  calls.length = 0; canCreate = true; changed = true
  await assert.rejects(preflightEditorAccess("fixture-document"), error => error instanceof DocumentSessionError && error.code === "SESSION_CHANGED")
  assert.deepEqual(calls, ["/api/document-session"])
})

test("DB-08: successful preflight discards newer server bytes and honors cancellation", async t => {
  setDocumentContext("fixture-context")
  let calls = 0
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls++
    if (url === "/api/document-session") return Response.json({ contextId: "fixture-context", canSave: true, canCreate: true })
    return Response.json({ document: { id: "fixture-document" }, revision: { id: "newer-revision", blob: btoa("newer server bytes") } }, { headers: { "X-Document-Context": "fixture-context" } })
  })
  assert.equal(await preflightEditorAccess("fixture-document"), undefined)
  assert.equal(calls, 2)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(preflightEditorAccess("fixture-document", { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls, 2)
})
