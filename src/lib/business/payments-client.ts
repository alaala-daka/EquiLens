import type { SaveProjectPayment } from "../payments/types"
import { createProjectReviewsClient, ProjectReviewError, reviewFailureFromResponse, type ProjectResultView, type ProjectReviewsClientOptions } from "./reviews-client"

/** Payment-specific writes; version reads, review and exports use the shared result client. */
export function createProjectPaymentsClient(options: ProjectReviewsClientOptions) {
  const results = createProjectReviewsClient(options)
  return {
    ...results,
    async listPayments(signal?: AbortSignal) {
      return (await results.listResults(signal)).filter(result => result.kind === "payment-reconciliation")
    },
    async save(input: SaveProjectPayment & { resultId?: string }, signal?: AbortSignal): Promise<ProjectResultView> {
      const check = () => { if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。") }
      check()
      if (options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能保存款项表。")
      const path = `/api/projects/${encodeURIComponent(options.projectId)}/payments${input.resultId ? `/${encodeURIComponent(input.resultId)}/revisions` : ""}`
      let response: Response
      try {
        response = await (options.fetch ?? fetch)(path, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: input.operationId, reason: input.reason, value: input.value,
            ...(input.resultId ? { baseVersionId: input.baseVersionId } : {}) }) })
      } catch { check(); throw new ProjectReviewError("FAILED", "网络连接失败，请重试。") }
      check()
      let body: unknown
      try { body = await response.json() } catch { throw new ProjectReviewError("FAILED", "款项响应无效。") }
      check()
      if (!response.ok) {
        const error = reviewFailureFromResponse(response.status, body)
        if (error.code === "SESSION_INVALID" || error.code === "ACCESS_DENIED") options.onAccessInvalid?.(error)
        throw error
      }
      const result = body as ProjectResultView
      if (result?.kind !== "payment-reconciliation" || typeof result.versionId !== "string" || typeof result.resultId !== "string") throw new ProjectReviewError("FAILED", "款项响应无效。")
      return result
    },
  }
}
