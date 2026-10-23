import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentSessionError, RevisionConflict, openDocument, setDocumentContext, getDocumentSession, restartDocumentSession, createDocument } from "./client"

test("DB-08: session failures remain distinct from revision conflicts", async t => {
  for (const [status, code] of [[409, "SESSION_CHANGED"], [410, "RETENTION_EXPIRED"], [409, "RETENTION_CONFIRMATION_CHANGED"]] as const) {
    setDocumentContext("synthetic-context")
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "会话错误", code }, { status }))
    await assert.rejects(openDocument("synthetic-document"), error => error instanceof DocumentSessionError && error.code === code)
    mock.mock.restore()
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "版本冲突", code: "REVISION_CONFLICT" }, { status: 409 }))
  await assert.rejects(openDocument("synthetic-document"), RevisionConflict)
})

test("DB-08: abort and mismatched headers prevent private response decoding", async t => {
  setDocumentContext("synthetic-context")
  let calls = 0
  let decoded = false
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    calls++
    assert.equal(new Headers(init?.headers).get("X-Document-Context"), "synthetic-context")
    assert.equal(init?.credentials, "same-origin")
    assert.equal(init?.cache, "no-store")
    const response = new Response("", { headers: { "X-Document-Context": "other-context" } })
    t.mock.method(response, "json", async () => { decoded = true; throw new Error("must not decode") })
    return response
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(openDocument("synthetic-document", controller.signal), { name: "AbortError" })
  await assert.rejects(createDocument(new Blob(), "合成资料", "authored", undefined, "", undefined, { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls, 0)
  await assert.rejects(openDocument("synthetic-document"), error => error instanceof DocumentSessionError && error.code === "SESSION_CHANGED")
  assert.equal(decoded, false)
})

test("DB-08: session reads and restart do not change the document context", async t => {
  setDocumentContext("current-context")
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "/api/document-session") return Response.json({ contextId: "late-context" })
    assert.equal(new Headers(init?.headers).get("X-Document-Context"), "current-context")
    return Response.json({ error: "已到期", code: "RETENTION_EXPIRED" }, { status: 410 })
  })
  await getDocumentSession()
  await restartDocumentSession()
  await assert.rejects(openDocument("synthetic-document"), DocumentSessionError)
})

test("DB-08: abort or session switch during encoding never submits old bytes", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not fetch") })
  const controller = new AbortController()
  const blob = new Blob(["synthetic"])
  const arrayBuffer = blob.arrayBuffer.bind(blob)
  const mock = t.mock.method(blob, "arrayBuffer", async () => { controller.abort(); return arrayBuffer() })
  setDocumentContext("original-context")
  await assert.rejects(createDocument(blob, "合成资料", "authored", undefined, "", undefined, { signal: controller.signal }), { name: "AbortError" })
  mock.mock.restore()
  t.mock.method(blob, "arrayBuffer", async () => { setDocumentContext("new-context"); return arrayBuffer() })
  await assert.rejects(createDocument(blob, "合成资料", "authored"), error => error instanceof DocumentSessionError && error.code === "SESSION_CHANGED")
  assert.equal(calls, 0)
})

