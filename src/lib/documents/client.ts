import { DOCX_TYPE, documentTitle, type DocumentRecord, type OpenDocument } from "./types"
import type { AnonymousSessionView, DocumentSessionCode, RetentionConsent } from "./session-types"

export class DocumentSessionError extends Error {
  constructor(message: string, readonly status: number, readonly code: DocumentSessionCode, readonly session?: AnonymousSessionView) {
    super(message)
    this.name = "DocumentSessionError"
  }
}

let documentContext = ""
export function setDocumentContext(contextId: string): void { documentContext = contextId }
export function getDocumentContext(): string { return documentContext }
export function documentSessionFailure(value: { code?: DocumentSessionCode; error?: string; session?: AnonymousSessionView }, status: number): DocumentSessionError | null {
  return value.code && sessionCodes.includes(value.code) ? new DocumentSessionError(value.error || "会话操作失败。", status, value.code, value.session) : null
}
const sessionCodes: readonly DocumentSessionCode[] = ["RETENTION_UNCONFIGURED", "RETENTION_EXPIRED", "LEGACY_RETENTION_PENDING", "SESSION_CONTEXT_REQUIRED", "SESSION_CHANGED", "RETENTION_CONSENT_REQUIRED", "RETENTION_CONFIRMATION_CHANGED", "RETENTION_READ_ONLY", "SESSION_RESTART_NOT_ALLOWED"]

export class RevisionConflict extends Error {
  constructor() { super("文档已在其他页面保存。请将当前编辑另存为新文档。") }
}

async function request(path: string, init?: RequestInit, signal?: AbortSignal, sessionControl = false) {
  signal?.throwIfAborted()
  const expectedContext = documentContext
  const headers = new Headers(init?.headers)
  if (!sessionControl) headers.set("X-Document-Context", expectedContext)
  const response = await fetch(sessionControl ? "/api/document-session" : `/api/documents${path}`, { ...init, headers, signal, credentials: "same-origin", cache: "no-store" })
  signal?.throwIfAborted()
  // Check headers before parsing private response content or decoding the DOCX.
  const assertContext = () => {
    if (!sessionControl && (documentContext !== expectedContext || response.headers.get("X-Document-Context") !== expectedContext)) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  }
  if (response.ok) assertContext()
  const value = await response.json()
  signal?.throwIfAborted()
  if (response.status === 409 && (value.code === "REVISION_CONFLICT" || (!value.code && value.error === "文档已在其他页面保存。请将当前编辑另存为新文档。"))) throw new RevisionConflict()
  if (!response.ok && sessionCodes.includes(value.code)) throw new DocumentSessionError(value.error || "会话操作失败。", response.status, value.code, value.session)
  if (!response.ok) throw new Error(value.error || "文档操作失败，请重试。")
  assertContext()
  return value
}

export function getDocumentSession(signal?: AbortSignal): Promise<AnonymousSessionView> { return request("", undefined, signal, true) }
export function restartDocumentSession(signal?: AbortSignal): Promise<AnonymousSessionView> {
  return request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restart", expectedContextId: documentContext }) }, signal, true)
}

type WireDocument = Omit<OpenDocument, "revision"> & { revision: Omit<OpenDocument["revision"], "blob"> & { blob: string } }
function decode(value: WireDocument, signal?: AbortSignal): OpenDocument {
  signal?.throwIfAborted()
  const bytes = Uint8Array.from(atob(value.revision.blob), character => character.charCodeAt(0))
  const result = { ...value, revision: { ...value.revision, blob: new Blob([bytes], { type: DOCX_TYPE }) } }
  signal?.throwIfAborted()
  return result
}
async function encode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384))
  return btoa(binary)
}

export function listDocuments(signal?: AbortSignal): Promise<DocumentRecord[]> { return request("", undefined, signal) }
export async function openDocument(id: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  return decode(await request(`/${encodeURIComponent(id)}`, undefined, signal), signal)
}
// Cached editor bytes still require a fresh server access check. Deliberately
// discard the response: it may be a newer revision than the user's selection.
export async function preflightEditorAccess(id: string, options?: { signal?: AbortSignal; copy?: boolean }): Promise<void> {
  const context = documentContext
  const view = await getDocumentSession(options?.signal)
  options?.signal?.throwIfAborted()
  if (context !== documentContext || view.contextId !== context) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  if (!view.canSave || (options?.copy && !view.canCreate)) throw new DocumentSessionError(view.issue?.message ?? "当前会话不允许编辑或复制文档。", 403, view.issue?.code ?? "RETENTION_READ_ONLY", view)
  await openDocument(id, options?.signal)
  options?.signal?.throwIfAborted()
}
export async function createDocument(blob: Blob, title: string, source: DocumentRecord["source"], fileName?: string, prompt = "", copiedFrom?: DocumentRecord["copiedFrom"], options?: { signal?: AbortSignal; retentionConsent?: RetentionConsent }) {
  const context = documentContext
  options?.signal?.throwIfAborted()
  const encoded = await encode(blob)
  options?.signal?.throwIfAborted()
  if (documentContext !== context) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  const result = await request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob: encoded, title: documentTitle(title), source, fileName, prompt, copiedFrom, retentionConsent: options?.retentionConsent }) }, options?.signal)
  options?.signal?.throwIfAborted()
  return decode(result, options?.signal)
}
export async function saveDocument(input: { documentId: string; baseRevision: string; operationId: string; title: string; prompt: string; blob: Blob }, options?: { signal?: AbortSignal }) {
  const signal = options?.signal
  const context = documentContext
  signal?.throwIfAborted()
  const blob = await encode(input.blob)
  signal?.throwIfAborted()
  if (documentContext !== context) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  return decode(await request(`/${encodeURIComponent(input.documentId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, title: documentTitle(input.title), blob }) }, signal), signal)
}
