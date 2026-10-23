import type { ReviewAvailability, ReviewTask, SubmitReview } from "./types"

async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  signal?.throwIfAborted()
  const response = await fetch("/api/contract-reviews" + path, { ...init, signal, credentials: "same-origin", cache: "no-store" })
  signal?.throwIfAborted()
  const value = await response.json()
  signal?.throwIfAborted()
  if (!response.ok) throw new Error(value.error || "审查操作失败，请重试。")
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
