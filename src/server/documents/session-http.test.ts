import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { connectDatabase } from "../database/connection"
import { DocumentRepository } from "./repository"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"
import { blankDocx } from "../../lib/documents/docx"
import { createDocumentCollectionHandlers, createDocumentVersionHandlers, createDocumentSessionHandlers } from "./handlers"

test("DB-08: actual SQLite handlers enforce context, expiry, isolation and explicit restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-session-http-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  let now = new Date("2026-10-22T00:00:00Z")
  const sessions = new DocumentSessionRepository(database, { now: () => now, readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }) })
  const documents = new DocumentRepository(database, sessions)
  const services = async () => ({ documents, sessions })
  const collection = createDocumentCollectionHandlers(services)
  const versions = createDocumentVersionHandlers(services)
  const controls = createDocumentSessionHandlers(services)
  const origin = "https://equilens.invalid"
  let cookie = ""
  let contextId = ""
  const request = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => new NextRequest(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, "X-Document-Context": contextId, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const denied = async (response: Response, status: number, code?: string) => {
    assert.equal(response.status, status)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal(response.headers.get("set-cookie"), null)
    const value = await response.json()
    if (code) assert.equal(value.code, code)
    assert.doesNotMatch(JSON.stringify(value), /"blob"|password|SQL|"owner"|equilens_session/)
  }
  try {
    const first = await controls.GET(request("/api/document-session"))
    const view = await first.json()
    assert.doesNotMatch(JSON.stringify(view), /"owner"|equilens_session|password|SQL/)
    cookie = first.headers.get("set-cookie")!.split(";")[0]
    contextId = view.contextId
    const originalCookie = cookie
    const originalContext = contextId
    const body = { title: "合成资料", source: "authored", prompt: "", blob: Buffer.from(await blankDocx().arrayBuffer()).toString("base64"), retentionConsent: view.confirmation }
    await denied(await collection.POST(request("/api/documents", "POST", body, { Origin: "" })), 403)
    await denied(await collection.POST(request("/api/documents", "POST", body, { Origin: "https://other.invalid" })), 403)
    await denied(await collection.POST(request("/api/documents", "POST", body, { "X-Document-Context": "" })), 400, "SESSION_CONTEXT_REQUIRED")
    await denied(await collection.GET(request("/api/documents", "GET", undefined, { "X-Document-Context": "other" })), 409, "SESSION_CHANGED")
    await denied(await collection.POST(request("/api/documents", "POST", { ...body, blob: Buffer.from("bad file").toString("base64") })), 422)
    await denied(await collection.POST(request("/api/documents", "POST", body, { "Content-Length": "99000000" })), 413)
    await denied(await controls.POST(request("/api/document-session", "POST", { action: "restart", expectedContextId: contextId })), 409, "SESSION_RESTART_NOT_ALLOWED")
    await denied(await controls.POST(request("/api/document-session", "POST", { action: "restart", expectedContextId: contextId }, { Origin: "" })), 403)
    const created = await collection.POST(request("/api/documents", "POST", body))
    assert.equal(created.status, 201)
    assert.equal(created.headers.get("X-Document-Context"), contextId)
    const saved = await created.json()
    const parameters = { params: Promise.resolve({ id: saved.document.id }) }
    const active = await (await controls.GET(request("/api/document-session"))).json()
    const expiry = new Date(active.expiresAt)
    now = new Date(expiry.getTime() - 1)
    const originalOpen = documents.open.bind(documents)
    const serialization = t.mock.method(documents, "open", async (...args: Parameters<DocumentRepository["open"]>) => {
      const result = await originalOpen(...args)
      const bytes = result.revision.blob.arrayBuffer.bind(result.revision.blob)
      result.revision.blob.arrayBuffer = async () => { const value = await bytes(); now = expiry; return value }
      return result
    })
    await denied(await versions.GET(request(`/api/documents/${saved.document.id}`), parameters), 410, "RETENTION_EXPIRED")
    serialization.mock.restore()
    // Validation runs a real child process; advance the injected clock after body consumption.
    now = new Date(expiry.getTime() - 1)
    const slow = request("/api/documents", "POST", body)
    const originalReader = slow.body!.getReader.bind(slow.body)
    t.mock.method(slow.body!, "getReader", () => {
      const reader = originalReader()
      const read = reader.read.bind(reader)
      reader.read = async () => { const result = await read(); if (result.done) now = expiry; return result }
      return reader
    })
    await denied(await collection.POST(slow), 410, "RETENTION_EXPIRED")
    assert.equal((await database.transaction(connection => connection.query("SELECT id FROM equilens_documents"))).rows.length, 1)
    await denied(await collection.GET(request("/api/documents")), 410, "RETENTION_EXPIRED")
    await denied(await versions.GET(request(`/api/documents/${saved.document.id}`), parameters), 410, "RETENTION_EXPIRED")
    await denied(await versions.PUT(request(`/api/documents/${saved.document.id}`, "PUT", { ...body, baseRevision: saved.revision.id, operationId: randomUUID() }), parameters), 410, "RETENTION_EXPIRED")
    await denied(await collection.POST(request("/api/documents", "POST", { ...body, source: "copy", copiedFrom: { documentId: saved.document.id, revisionId: saved.revision.id } })), 410, "RETENTION_EXPIRED")
    const originalView = sessions.view.bind(sessions)
    let views = 0
    const failedRestart = t.mock.method(sessions, "view", async (owner: string) => {
      if (++views === 3) throw new Error("SQL password owner cookie")
      return originalView(owner)
    })
    await denied(await controls.POST(request("/api/document-session", "POST", { action: "restart", expectedContextId: contextId })), 503)
    failedRestart.mock.restore()
    const restarted = await controls.POST(request("/api/document-session", "POST", { action: "restart", expectedContextId: contextId }))
    assert.equal(restarted.status, 200)
    cookie = restarted.headers.get("set-cookie")!.split(";")[0]
    assert.notEqual(cookie, originalCookie)
    contextId = (await restarted.json()).contextId
    assert.deepEqual(await (await collection.GET(request("/api/documents"))).json(), [])
    await denied(await versions.GET(request(`/api/documents/${saved.document.id}`), parameters), 404)
    await denied(await collection.POST(request("/api/documents", "POST", { ...body, source: "copy", copiedFrom: { documentId: saved.document.id, revisionId: saved.revision.id } })), 404)
    cookie = originalCookie
    contextId = originalContext
    await denied(await collection.GET(request("/api/documents")), 410, "RETENTION_EXPIRED")
  } finally { await database.close(); await rm(directory, { recursive: true }) }
})

