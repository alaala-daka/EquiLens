import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentSessionError, RevisionConflict, preflightEditorAccess, setDocumentContext } from "./client"
import { blankDocx } from "./docx"
import {
  createAnonymousEditorAccess, createEditorSessionDependencies, describeEditorFailure, EditorAccessError,
} from "./editor-access"
import { createEditorSession } from "./editor-session"
import type { AnonymousSessionView } from "./session-types"
import type { OpenDocument } from "./types"

const contextId = "fixture-context"
const at = "2026-10-28T00:00:00.000Z"

async function encodeBlob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function bound(blob: Blob, documentId = "fixture-document", revisionId = "revision-1"): OpenDocument {
  return {
    document: {
      id: documentId, title: "合成合同", prompt: "", source: "authored",
      createdAt: at, updatedAt: at, currentRevision: revisionId,
    },
    revision: {
      id: revisionId, documentId, parentId: null, blob, hash: "synthetic-hash",
      createdAt: at, editorVersion: "superdoc@1.47.2", templateVersion: null,
    },
  }
}

async function wire(opened: OpenDocument) {
  return {
    document: opened.document,
    revision: { ...opened.revision, blob: await encodeBlob(opened.revision.blob) },
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json", "X-Document-Context": contextId },
  })
}

function view(overrides: Partial<AnonymousSessionView> = {}): AnonymousSessionView {
  return {
    contextId, state: "active", expiresAt: null, exportUntil: null,
    canRead: true, canSave: true, canCreate: true, canRestart: false, confirmation: null,
    ...overrides,
  }
}

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

test("A2/DB-08: anonymous adapter keeps preflight capability checks and raw failures", async t => {
  setDocumentContext(contextId)
  const access = createAnonymousEditorAccess()
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url))
    return Response.json({ ...view({ canSave: false, canCreate: false }), contextId })
  })
  await assert.rejects(access.preflight("fixture-document", { copy: false }),
    error => error instanceof DocumentSessionError && error.code === "RETENTION_READ_ONLY")
  assert.deepEqual(calls, ["/api/document-session"], "a denied view never opens the private resource")
  calls.length = 0
  await assert.rejects(access.preflight("fixture-document", { copy: true }),
    error => error instanceof DocumentSessionError && error.code === "RETENTION_READ_ONLY")
  assert.deepEqual(calls, ["/api/document-session"])
})

test("A2/DB-08: anonymous adapter open returns the saved bytes and title", async t => {
  setDocumentContext(contextId)
  const blob = blankDocx()
  t.mock.method(globalThis, "fetch", async () => json(await wire(bound(blob))))
  const opened = await createAnonymousEditorAccess().open("fixture-document")
  assert.equal(opened.document.id, "fixture-document")
  assert.equal(opened.revision.id, "revision-1")
  assert.deepEqual(new Uint8Array(await opened.revision.blob.arrayBuffer()),
    new Uint8Array(await blob.arrayBuffer()))
})

test("A2/UI-08/DB-02: anonymous adapter save keeps operationId, baseRevision and exact bytes", async t => {
  setDocumentContext(contextId)
  const blob = blankDocx()
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return json(await wire(bound(blob, "fixture-document", "new-revision")))
  })
  const saved = await createAnonymousEditorAccess().save({
    documentId: "fixture-document", baseRevision: "revision-1", operationId: "operation-1",
    title: "  合成合同  ", prompt: "核对付款条款", blob,
  })
  assert.deepEqual(bodies, [{
    documentId: "fixture-document", baseRevision: "revision-1", operationId: "operation-1",
    title: "合成合同", prompt: "核对付款条款", blob: await encodeBlob(blob),
  }])
  assert.equal(saved.revision.id, "new-revision")
  assert.deepEqual(new Uint8Array(await saved.revision.blob.arrayBuffer()),
    new Uint8Array(await blob.arrayBuffer()))
})

test("A2/UI-09: anonymous adapter copy keeps provenance, prompt and serialized bytes", async t => {
  setDocumentContext(contextId)
  const blob = blankDocx()
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return json(await wire(bound(blob, "copy-document", "copy-revision")))
  })
  const copied = await createAnonymousEditorAccess().copy({
    blob, title: "合成合同 副本", source: "copy", prompt: "另存输入",
    copiedFrom: { documentId: "fixture-document", revisionId: "revision-1" },
  })
  assert.deepEqual(bodies, [{
    blob: await encodeBlob(blob), title: "合成合同 副本", source: "copy",
    prompt: "另存输入", copiedFrom: { documentId: "fixture-document", revisionId: "revision-1" },
  }])
  assert.equal(copied.document.id, "copy-document")
})

test("A2/UI-11: anonymous adapter download uses the injected workspace downloader", () => {
  const downloads: { blob: Blob; title: string }[] = []
  const blob = new Blob(["synthetic"])
  createAnonymousEditorAccess({ download: (value, title) => downloads.push({ blob: value, title }) })
    .download(blob, "合成合同")
  assert.deepEqual(downloads, [{ blob, title: "合成合同" }])
})

test("A2/DB-08: shared failure classes do not depend on anonymous session error codes", () => {
  const code = (failure: unknown) => describeEditorFailure(failure).code
  for (const sessionCode of ["RETENTION_EXPIRED", "SESSION_CHANGED", "SESSION_CONTEXT_REQUIRED", "RETENTION_READ_ONLY", "LEGACY_RETENTION_PENDING"] as const) {
    assert.equal(code(new DocumentSessionError("不可继续", 409, sessionCode)), "SESSION_INVALID", sessionCode)
  }
  assert.equal(code(new DocumentSessionError("不可继续", 403, "SESSION_CHANGED", view({ canSave: false }))), "SESSION_INVALID")
  // Copy/consent denials leave an existing, readable document alone.
  for (const sessionCode of ["RETENTION_UNCONFIGURED", "RETENTION_CONSENT_REQUIRED", "RETENTION_CONFIRMATION_CHANGED", "SESSION_RESTART_NOT_ALLOWED"] as const) {
    assert.equal(code(new DocumentSessionError("当前操作不可用", 403, sessionCode, view({ canCreate: false }))), "ACCESS_DENIED", sessionCode)
  }
  assert.equal(code(new RevisionConflict()), "CONFLICT")
  assert.equal(code(new Error("响应丢失")), "FAILED")
  assert.equal(describeEditorFailure(new Error("响应丢失")).message, "响应丢失")
  const aborted = new Error("aborted"); aborted.name = "AbortError"
  assert.equal(code(aborted), "ABORTED")
  assert.equal(code(new EditorAccessError("SESSION_INVALID", "登录已失效，请重新登录。")), "SESSION_INVALID")
  assert.equal(describeEditorFailure(new EditorAccessError("CONFLICT", "版本冲突")).retryable, false)
})

test("A2/DB-08: anonymous adapter notifies only for the original session failure", () => {
  const failures: DocumentSessionError[] = []
  const access = createAnonymousEditorAccess({ onSessionInvalid: failure => failures.push(failure) })
  const failure = new DocumentSessionError("会话已变更", 409, "SESSION_CHANGED")
  access.notifySessionInvalid?.(failure)
  access.notifySessionInvalid?.(new EditorAccessError("SESSION_INVALID", "项目登录已失效"))
  access.notifySessionInvalid?.(new Error("其他失败"))
  assert.deepEqual(failures, [failure])
})

test("A2/UI-08: editor session saves through the anonymous adapter without changing its payload", async t => {
  setDocumentContext(contextId)
  const blob = blankDocx()
  const opened = bound(blob)
  const bodies: Record<string, unknown>[] = []
  const saved: OpenDocument[] = []
  const invalid: DocumentSessionError[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "/api/document-session") return Response.json({ ...view(), contextId })
    if (init?.method === "PUT") {
      bodies.push(JSON.parse(String(init.body)))
      return json(await wire(bound(blob, opened.document.id, "new-revision")))
    }
    return json(await wire(opened))
  })
  const session = createEditorSession(createEditorSessionDependencies({
    access: createAnonymousEditorAccess({ onSessionInvalid: failure => invalid.push(failure) }),
    opened, serialize: async () => blob, onSaved: value => saved.push(value),
  }))
  try {
    session.activate()
    session.setEngine("ready")
    session.markBodyChanged()
    const result = await session.run("save")
    assert.ok(result)
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].baseRevision, opened.revision.id)
    assert.equal(typeof bodies[0].operationId, "string")
    assert.equal(bodies[0].blob, await encodeBlob(blob))
    assert.equal((result as OpenDocument).revision.id, "new-revision")
    assert.deepEqual(saved, [result])
    assert.equal(invalid.length, 0)
  } finally { session.dispose() }
})

test("A2/DB-08/UI-13: adapter-classified session failure is terminal and keeps unsaved inputs", async t => {
  setDocumentContext(contextId)
  const blob = blankDocx()
  const opened = bound(blob)
  const invalid: DocumentSessionError[] = []
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...view({ canSave: false }), contextId }))
  const session = createEditorSession(createEditorSessionDependencies({
    access: createAnonymousEditorAccess({ onSessionInvalid: failure => invalid.push(failure) }),
    opened, serialize: async () => blob, onSaved: () => {},
  }))
  try {
    session.activate()
    session.setEngine("ready")
    session.editPrompt("未保存输入")
    assert.equal(await session.run("save"), null)
    assert.equal(invalid.length, 1)
    assert.equal(invalid[0].code, "RETENTION_READ_ONLY")
    assert.equal(session.getSnapshot().prompt, "未保存输入")
    assert.equal(session.getSnapshot().dirty, true)
    assert.equal(await session.run("save"), null)
    assert.equal(invalid.length, 1, "a terminal access failure is reported once")
  } finally { session.dispose() }
})
