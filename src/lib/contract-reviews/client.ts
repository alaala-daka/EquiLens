import type { ReviewAvailability, ReviewTask, SubmitReview } from "./types"
import type { DocumentReview, DocumentRevision } from "../document-agent/revisions"
import { DocumentSessionError, documentSessionFailure, getDocumentContext } from "../documents/client"

export class RevisionDownloadError extends Error {
  constructor(message: string, readonly code: "REVISION_TASK_REQUIRED" | "REVISION_NOT_READY", readonly revisionTaskId?: string) {
    super(message)
    this.name = "RevisionDownloadError"
  }
}

async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  signal?.throwIfAborted()
  const expectedContext = getDocumentContext()
  const headers = new Headers(init?.headers)
  headers.set("X-Document-Context", expectedContext)
  const response = await fetch("/api/contract-reviews" + path, { ...init, headers, signal, credentials: "same-origin", cache: "no-store" })
  signal?.throwIfAborted()
  const assertContext = () => {
    if (expectedContext !== getDocumentContext() || response.headers.get("X-Document-Context") !== expectedContext) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  }
  if (response.ok) assertContext()
  const value = await response.json()
  signal?.throwIfAborted()
  if (!response.ok) {
    const sessionFailure = documentSessionFailure(value, response.status)
    if (sessionFailure) throw sessionFailure
  }
  if (!response.ok) throw new Error(value.error || "审查操作失败，请重试。")
  assertContext()
  return value as T
}
export function listReviewTasks(documentId?: string, signal?: AbortSignal) {
  return request<{ configuration: ReviewAvailability; tasks: ReviewTask[] }>(documentId ? "?documentId=" + encodeURIComponent(documentId) : "", signal)
}
export function readReviewTask(id: string, signal?: AbortSignal) { return request<ReviewTask>("/" + encodeURIComponent(id), signal) }
export function createReviewTask(input: SubmitReview, key: string, signal?: AbortSignal) {
  return request<ReviewTask>("", signal, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input) })
}
export function actOnReviewTask(id: string, action: "cancel" | "retry", signal?: AbortSignal) {
  return request<ReviewTask>("/" + encodeURIComponent(id), signal, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action === "retry" ? { action, externalProcessingConsent: true } : { action }) })
}

export function createRevisionTask(id: string, ruleIds: string[], key: string, signal?: AbortSignal) {
  return request<ReviewTask>("/" + encodeURIComponent(id) + "/revision", signal, { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ externalProcessingConsent: true, ruleIds }) })
}

export function readDocumentRevisions(id: string, signal?: AbortSignal) {
  return request<{ machine: DocumentRevision; revisions: DocumentRevision[] }>("/" + encodeURIComponent(id) + "/revisions", signal)
}
export function saveDocumentRevision(id: string, body: { baseVersionId: string; extraction: unknown; changeReason: string; createdBy: string }, signal?: AbortSignal) {
  return request<DocumentRevision>("/" + encodeURIComponent(id) + "/revisions", signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}
export function reviewDocumentRevision(id: string, versionId: string, body: { decision: DocumentReview["decision"]; reviewer: string; note: string }, signal?: AbortSignal) {
  return request<DocumentReview>("/" + encodeURIComponent(id) + "/revisions/" + encodeURIComponent(versionId) + "/review", signal,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

export async function downloadReviewedLetter(id: string, versionId: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const expectedContext = getDocumentContext()
  const response = await fetch("/api/contract-reviews/" + encodeURIComponent(id) + "/revisions/" + encodeURIComponent(versionId) + "/letter", {
    headers: { "X-Document-Context": expectedContext }, signal, credentials: "same-origin", cache: "no-store",
  })
  signal?.throwIfAborted()
  if (!response.ok) {
    const error = await response.json()
    const sessionFailure = documentSessionFailure(error, response.status)
    if (sessionFailure) throw sessionFailure
    throw new Error(error.error || "已复核催款函下载失败，请重试。")
  }
  if (expectedContext !== getDocumentContext() || response.headers.get("X-Document-Context") !== expectedContext) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  const blob = await response.blob()
  if (response.headers.get("Content-Type") !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || !blob.size) throw new Error("催款函文件响应无效。")
  return blob
}

export async function downloadRevisedContract(id: string, signal?: AbortSignal): Promise<Blob> { return downloadTaskWord(id, "revision", signal) }
export async function downloadCollectionLetter(id: string, signal?: AbortSignal): Promise<Blob> { return downloadTaskWord(id, "letter", signal) }
async function downloadTaskWord(id: string, kind: "revision" | "letter", signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const expectedContext = getDocumentContext()
  const response = await fetch("/api/contract-reviews/" + encodeURIComponent(id) + "/" + kind, {
    headers: { "X-Document-Context": expectedContext }, signal, credentials: "same-origin", cache: "no-store",
  })
  signal?.throwIfAborted()
  if (!response.ok) {
    if (expectedContext !== getDocumentContext()) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
    const error = await response.json()
    signal?.throwIfAborted()
    const sessionFailure = documentSessionFailure(error, response.status)
    if (sessionFailure) throw sessionFailure
    if (kind === "revision" && response.status === 409 && (error.code === "REVISION_NOT_READY" ||
      (error.code === "REVISION_TASK_REQUIRED" && typeof error.revisionTaskId === "string" && /^[0-9a-f-]{36}$/.test(error.revisionTaskId)))) {
      if (expectedContext !== getDocumentContext()) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
      throw new RevisionDownloadError(error.error || "请打开对应修订任务查看进度。", error.code,
        error.code === "REVISION_TASK_REQUIRED" ? error.revisionTaskId : undefined)
    }
    throw new Error(error.error || "修订稿下载失败，请重试。")
  }
  const assertContext = () => {
    if (expectedContext !== getDocumentContext() || response.headers.get("X-Document-Context") !== expectedContext) throw new DocumentSessionError("会话已变更，请重新读取文档。", 409, "SESSION_CHANGED")
  }
  assertContext()
  const blob = await response.blob()
  signal?.throwIfAborted()
  assertContext()
  if (response.headers.get("Content-Type") !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || !blob.size) throw new Error("修订文件响应无效。")
  return blob
}
