import type { EvidenceItem, EvidenceReportValue, SaveEvidenceItem, SaveEvidenceReport } from "../evidence/types"
import type { ProjectFactVersion } from "../facts/types"
import { createProjectReviewsClient, ProjectReviewError, reviewFailureFromResponse, type ProjectResultView, type ProjectReviewsClientOptions } from "./reviews-client"

/** 证据项写入与读取；报告版本读取、复核与导出复用共享成果客户端。 */
export function createProjectEvidenceClient(options: ProjectReviewsClientOptions) {
  const results = createProjectReviewsClient(options)
  const base = `/api/projects/${encodeURIComponent(options.projectId)}`
  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。")
  }
  async function request<T>(url: string, signal?: AbortSignal, input?: unknown): Promise<T> {
    check(signal)
    if (input !== undefined && options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能操作项目证据。")
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
    try { value = await response.json() } catch { throw new ProjectReviewError("FAILED", "证据响应无效。") }
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
    async listEvidenceItems(signal?: AbortSignal): Promise<EvidenceItem[]> {
      return (await request<{ items: EvidenceItem[] }>(`${base}/evidence-items`, signal)).items
    },
    async listFacts(signal?: AbortSignal): Promise<ProjectFactVersion[]> {
      return (await request<{ facts: ProjectFactVersion[] }>(`${base}/facts`, signal)).facts
    },
    async evidenceItemHistory(itemId: string, signal?: AbortSignal): Promise<EvidenceItem[]> {
      return (await request<{ versions: EvidenceItem[] }>(`${base}/evidence-items/${encodeURIComponent(itemId)}`, signal)).versions
    },
    async saveEvidenceItem(input: SaveEvidenceItem, signal?: AbortSignal): Promise<EvidenceItem> {
      const saved = (await request<{ item: EvidenceItem }>(`${base}/evidence-items`, signal, input)).item
      if (!saved || typeof saved.versionId !== "string" || saved.sha256.length !== 64) throw new ProjectReviewError("FAILED", "证据响应无效。")
      return saved
    },
    async listEvidenceReports(signal?: AbortSignal): Promise<ProjectResultView[]> {
      return (await results.listResults(signal)).filter(result => result.kind === "evidence-report")
    },
    async saveEvidenceReport(input: SaveEvidenceReport & { resultId?: string }, signal?: AbortSignal): Promise<ProjectResultView> {
      const path = input.resultId ? `${base}/evidence-reports/${encodeURIComponent(input.resultId)}/revisions` : `${base}/evidence-reports`
      const result = await request<ProjectResultView>(path, signal, { operationId: input.operationId, reason: input.reason, baseVersionId: input.baseVersionId, value: input.value })
      if (result?.kind !== "evidence-report" || typeof result.versionId !== "string") throw new ProjectReviewError("FAILED", "证据报告响应无效。")
      return result
    },
    /** 只读所选保存版本的 Markdown（与 Word 同版本、同状态）。 */
    async downloadReportMarkdown(result: { resultId: string; versionId: string }, signal?: AbortSignal): Promise<Blob> {
      check(signal)
      const url = `${base}/evidence-reports/${encodeURIComponent(result.resultId)}/markdown?versionId=${encodeURIComponent(result.versionId)}`
      let response: Response
      try { response = await (options.fetch ?? fetch)(url, { signal, credentials: "same-origin", cache: "no-store" }) }
      catch { check(signal); throw new ProjectReviewError("FAILED", "网络连接失败，请重试。") }
      check(signal)
      if (!response.ok) {
        let body: unknown = null
        try { body = await response.json() } catch { body = null }
        const failure = reviewFailureFromResponse(response.status, body)
        if (response.status === 401 || response.status === 403) options.onAccessInvalid?.(failure)
        throw failure
      }
      return new Blob([await response.text()], { type: "text/markdown;charset=utf-8" })
    },
    reportValue: (result: ProjectResultView | null): EvidenceReportValue | null => {
      const value = result?.value as EvidenceReportValue | undefined
      return value && value.schemaVersion === 1 && Array.isArray(value.items) ? value : null
    },
  }
}
