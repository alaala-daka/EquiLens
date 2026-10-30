import type { ProjectFactVersion, SaveProjectFact } from "../facts/types"
import type { FactCandidatesValue } from "@/server/facts/result-validator"
import { createProjectReviewsClient, ProjectReviewError, reviewFailureFromResponse, type ProjectReviewsClientOptions, type ProjectTaskView } from "./reviews-client"

export type { FactCandidatesValue, FactCandidate } from "@/server/facts/result-validator"

export function createProjectFactsClient(options: ProjectReviewsClientOptions) {
  const common = createProjectReviewsClient(options)
  const base = `/api/projects/${encodeURIComponent(options.projectId)}/facts`
  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。")
  }
  async function request<T>(url: string, signal?: AbortSignal, input?: unknown, operationId?: string): Promise<T> {
    check(signal)
    if (input !== undefined && options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能执行此操作。")
    let response: Response
    try { response = await (options.fetch ?? fetch)(url, { signal, credentials: "same-origin", cache: "no-store", ...(input === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", ...(operationId ? { "Idempotency-Key": operationId } : {}) }, body: JSON.stringify(input),
    }) }) } catch {
      check(signal)
      throw new ProjectReviewError("FAILED", "网络连接失败，请重试。")
    }
    check(signal)
    const value = await response.json()
    check(signal)
    if (!response.ok) {
      const failure = reviewFailureFromResponse(response.status, value)
      if (response.status === 401 || response.status === 403) options.onAccessInvalid?.(failure)
      throw failure
    }
    return value as T
  }
  return {
    list: async (signal?: AbortSignal, contractId?: string) => (await request<{ facts: ProjectFactVersion[] }>(base + (contractId ? `?contractId=${encodeURIComponent(contractId)}` : ""), signal)).facts,
    history: async (factId: string, signal?: AbortSignal) => (await request<{ versions: ProjectFactVersion[] }>(`${base}/${encodeURIComponent(factId)}`, signal)).versions,
    save: async (input: SaveProjectFact, signal?: AbortSignal) => (await request<{ fact: ProjectFactVersion }>(base, signal, input)).fact,
    listMaterials: common.listMaterials,
    listTasks: async (signal?: AbortSignal) => (await common.listTasks(signal)).filter(task => task.kind === "document-analysis"),
    getTask: common.getTask,
    listCandidates: async (signal?: AbortSignal) => (await common.listResults(signal)).filter(result => result.kind === "fact-candidates").map(result => ({ ...result, value: result.value as FactCandidatesValue })),
    prepare: (materials: Array<{ materialVersionId: string; sha256: string }>, operationId: string, signal?: AbortSignal) => request<{ task: ProjectTaskView; created: boolean }>("/api/tasks", signal, {
      projectId: options.projectId, kind: "document-analysis", refs: { materials }, conditions: { externalProcessingConsent: true },
    }, operationId),
  }
}
