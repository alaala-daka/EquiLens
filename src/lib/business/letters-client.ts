import type { CollectionLetterDraft, CollectionLetterValue, LetterVersionRef, SaveCollectionLetter } from "../letters/types"
import type { ProjectFactVersion } from "../facts/types"
import { createProjectReviewsClient, ProjectReviewError, reviewFailureFromResponse, type ProjectResultView, type ProjectReviewsClientOptions } from "./reviews-client"

type LetterDraftInput = Omit<CollectionLetterDraft, "payment"> & { payment: LetterVersionRef }

/** 催款函写入；版本读取、复核与导出复用共享成果客户端。 */
export function createProjectLettersClient(options: ProjectReviewsClientOptions) {
  const results = createProjectReviewsClient(options)
  const base = `/api/projects/${encodeURIComponent(options.projectId)}`
  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。")
  }
  async function request<T>(url: string, signal?: AbortSignal, input?: unknown): Promise<T> {
    check(signal)
    if (input !== undefined && options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能操作项目催款函。")
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(url, { signal, credentials: "same-origin", cache: "no-store",
        ...(input === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }) })
    } catch {
      check(signal)
      throw new ProjectReviewError("FAILED", "网络连接失败，请重试。")
    }
    check(signal)
    let value: unknown
    try { value = await response.json() } catch { throw new ProjectReviewError("FAILED", "催款函响应无效。") }
    check(signal)
    if (!response.ok) {
      const failure = reviewFailureFromResponse(response.status, value)
      if (response.status === 401 || response.status === 403) options.onAccessInvalid?.(failure)
      throw failure
    }
    return value as T
  }
  return {
    ...results,
    async listLetters(signal?: AbortSignal): Promise<ProjectResultView[]> {
      return (await results.listResults(signal)).filter(result => result.kind === "collection-letter")
    },
    async listFacts(signal?: AbortSignal): Promise<ProjectFactVersion[]> {
      return (await request<{ facts: ProjectFactVersion[] }>(`${base}/facts`, signal)).facts
    },
    async saveLetter(input: Omit<SaveCollectionLetter, "value"> & { value: LetterDraftInput; resultId?: string }, signal?: AbortSignal): Promise<ProjectResultView> {
      const path = input.resultId ? `${base}/letters/${encodeURIComponent(input.resultId)}/revisions` : `${base}/letters`
      const result = await request<ProjectResultView>(path, signal, { operationId: input.operationId, reason: input.reason, baseVersionId: input.baseVersionId, value: input.value })
      if (result?.kind !== "collection-letter" || typeof result.versionId !== "string") throw new ProjectReviewError("FAILED", "催款函响应无效。")
      return result
    },
    letterValue: (result: ProjectResultView | null): CollectionLetterValue | null => {
      const value = result?.value as CollectionLetterValue | undefined
      return value && value.schemaVersion === 1 && Array.isArray(value.paragraphs) ? value : null
    },
  }
}
