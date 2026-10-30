import type {
  ExportRef,
  ProjectReviewConditions,
  ProjectReviewMaterialRef,
  ResultReview,
  ResultValidation,
} from "./contracts"
import type { MaterialSummary } from "./materials-client"
import { DOCX_TYPE } from "../documents/types"

/**
 * Project contract-review client (B2a).
 *
 * Consumes the frozen round-three HTTP contract only: POST/GET /api/tasks,
 * GET /api/projects/[id]/results, validate/review, exports and material reads.
 * It never builds a manifest, model address, price or budget; the server
 * catalogue remains the single authority. Writes are locally refused for a
 * read-only member, and no failure is retried automatically.
 */

/** Material collection shape includes the immutable version digest needed by the frozen refs. */
export type ProjectReviewMaterial = MaterialSummary & { sha256: string }

export type ProjectTaskState = "queued" | "running" | "success" | "partial" | "failed" | "cancelled"

export type ProjectTaskManifest = {
  version?: number
  catalogVersion?: number
  kind?: string
  projectId?: string
  refs?: { materials?: ProjectReviewMaterialRef[] }
  conditions?: Partial<ProjectReviewConditions>
  submittedBy?: string
  submittedAt?: string
}

/** TaskView as returned by the shared task HTTP contract. */
export type ProjectTaskView = {
  id: string
  kind: string
  projectId: string
  state: ProjectTaskState
  stage: string
  createdAt: string
  updatedAt: string
  attempt: number
  maxAttempts: number
  callsUsed: number
  maxCalls: number
  elapsedMs: number
  manifest: ProjectTaskManifest
  error: { code: string; message: string } | null
  resultSummary: string | null
}

/** Admin-only project paid-call ceiling returned by the budget HTTP contract. */
export type ProjectBudgetView = {
  projectId: string
  costLimitFen: number
  costReservedFen: number
  costChargedFen: number
  /** Raw remaining amount; it may be negative after a known overage (no clamping). */
  remainingFen: number
  registeredBy: string
  registeredAt: string
  updatedAt: string
  revision: number
}

export type ProjectResultSource = { fragmentId: string; snapshotId: string; quote: string }
export type ProjectResultDependency = { kind: string; id: string; versionId: string }

/** ResultView returned by the shared result HTTP contract. `value` stays unknown until decoded. */
export type ProjectResultView = {
  projectId: string
  resultId: string
  versionId: string
  sha256: string
  kind: string
  value: unknown
  machineOutput: unknown
  origin: string
  sources: ProjectResultSource[]
  dependencies: ProjectResultDependency[]
  provenance: { taskId: string; attempt: number; manifest: unknown; manifestHash: string } | null
  validation: ResultValidation
  review: ResultReview | null
  createdAt: string
  createdBy: string
  reason: string
}

export type ReviewFailureCode =
  | "ABORTED"
  | "SESSION_INVALID"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "FAILED"

/** Provider-neutral review failure; `serverCode` keeps the exact safe business code when present. */
export class ProjectReviewError extends Error {
  readonly code: ReviewFailureCode
  readonly status: number
  readonly serverCode?: string

  constructor(code: ReviewFailureCode, message: string, options: { status?: number; serverCode?: string } = {}) {
    super(message)
    this.name = "ProjectReviewError"
    this.code = code
    this.status = options.status ?? 0
    this.serverCode = options.serverCode
  }
}

const fallbackMessages: Record<number, string> = {
  400: "请求内容无效，请检查后重试。",
  401: "会话已失效，请重新登录。",
  403: "无权执行该操作。",
  404: "找不到对应的任务或成果。",
  409: "当前状态已变化，请重新读取后重试。",
  413: "请求内容过大。",
  415: "请求格式无效。",
  422: "提交内容未通过校验，请检查后重试。",
  429: "请求过于频繁，请稍后重试。",
  503: "服务暂不可用，请稍后重试。",
}

const codesByStatus: Record<number, ReviewFailureCode> = {
  400: "INVALID",
  401: "SESSION_INVALID",
  403: "ACCESS_DENIED",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "INVALID",
  415: "INVALID",
  422: "INVALID",
  429: "RATE_LIMITED",
  503: "UNAVAILABLE",
}

function serverError(value: unknown): { code?: string; message?: string } {
  if (!value || typeof value !== "object") return {}
  const error = (value as { error?: unknown }).error
  if (!error || typeof error !== "object") return {}
  const code = (error as { code?: unknown }).code
  const message = (error as { message?: unknown }).message
  return {
    ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? { code } : {}),
    // Only fixed, safe product strings are shown; HTML/control characters fall back to the status message.
    ...(typeof message === "string" && message.trim() && message.length <= 300 && !/[\u0000-\u001f<>]/.test(message) ? { message } : {}),
  }
}

/** Map an HTTP failure to the shared client vocabulary; server product messages are preserved. */
export function reviewFailureFromResponse(status: number, body: unknown): ProjectReviewError {
  const details = serverError(body)
  const code = codesByStatus[status] ?? "FAILED"
  const message = details.message ?? fallbackMessages[status] ?? "请求失败，请稍后重试。"
  return new ProjectReviewError(code, message, { status, serverCode: details.code })
}

function invalidResponse(): ProjectReviewError {
  return new ProjectReviewError("FAILED", "服务返回内容无效，请重试。")
}

function isAbort(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && (failure as { name?: unknown }).name === "AbortError"
}

export type ProjectReviewsClientOptions = {
  projectId: string
  /** False after unmount, project switch or access pause; late responses become ABORTED. */
  isCurrent: () => boolean
  /** False for a read-only member: write calls are refused before any request is sent. */
  canEdit?: () => boolean
  /** True only for a project administrator: budget reads/writes are refused locally otherwise. */
  canManage?: () => boolean
  onAccessInvalid?: (failure: ProjectReviewError) => void
  fetch?: typeof fetch
}

export type ReviewSubmission = {
  materials: ProjectReviewMaterialRef[]
  conditions: ProjectReviewConditions
}

type RequestInit = {
  method?: "GET" | "POST"
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function createProjectReviewsClient(options: ProjectReviewsClientOptions) {
  const transport = options.fetch ?? fetch
  const base = `/api/projects/${encodeURIComponent(options.projectId)}`

  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。")
  }

  function checkEditable() {
    if (options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能执行此操作。")
  }

  function checkManage() {
    if (options.canManage?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只有项目管理员可以登记审查预算。")
  }

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    check(init.signal)
    const headers: Record<string, string> = { ...init.headers }
    let body: string | undefined
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(init.body)
    }
    let response: Response
    try {
      response = await transport(path, {
        method: init.method ?? "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: init.signal,
      })
    } catch (failure) {
      if (init.signal?.aborted || isAbort(failure)) throw new ProjectReviewError("ABORTED", "操作已取消。")
      check(init.signal)
      throw new ProjectReviewError("FAILED", "网络连接失败，请重试。")
    }
    check(init.signal)
    if (!response.ok) {
      let detail: unknown = null
      try { detail = await response.json() } catch { detail = null }
      check(init.signal)
      const failure = reviewFailureFromResponse(response.status, detail)
      if (failure.code === "SESSION_INVALID" || failure.code === "ACCESS_DENIED") options.onAccessInvalid?.(failure)
      throw failure
    }
    return response
  }

  async function json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await send(path, init)
    let value: unknown
    try { value = await response.json() } catch { check(init.signal); throw invalidResponse() }
    check(init.signal)
    return value
  }

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse()
    return value as Record<string, unknown>
  }

  function taskView(value: unknown): ProjectTaskView {
    const task = record(value)
    if (typeof task.id !== "string" || typeof task.state !== "string" || typeof task.createdAt !== "string") throw invalidResponse()
    return task as unknown as ProjectTaskView
  }

  function resultView(value: unknown): ProjectResultView {
    const result = record(value)
    if (typeof result.resultId !== "string" || typeof result.versionId !== "string" || typeof result.sha256 !== "string" || typeof result.kind !== "string") throw invalidResponse()
    return result as unknown as ProjectResultView
  }

  function validation(value: unknown): ResultValidation {
    const checked = record(value)
    if (!["valid", "invalid", "partial"].includes(String(checked.status)) || typeof checked.versionId !== "string" || !Array.isArray(checked.issues)) throw invalidResponse()
    return checked as unknown as ResultValidation
  }

  const taskBase = "/api/tasks"
  return {
    /**
     * GET /api/projects/[id]/budget — administrator-only paid-call ceiling.
     * Returns null when the project has not registered a budget yet.
     */
    async getBudget(signal?: AbortSignal): Promise<ProjectBudgetView | null> {
      checkManage()
      const value = record(await json(`${base}/budget`, { signal }))
      if (!("budget" in value)) throw invalidResponse()
      if (value.budget === null) return null
      const budget = record(value.budget)
      if (typeof budget.costLimitFen !== "number" || typeof budget.remainingFen !== "number") throw invalidResponse()
      return budget as unknown as ProjectBudgetView
    },
    /** POST /api/projects/[id]/budget — register or update the ceiling (never below committed). */
    async registerBudget(costLimitFen: number, signal?: AbortSignal): Promise<ProjectBudgetView> {
      checkManage()
      if (!Number.isSafeInteger(costLimitFen) || costLimitFen <= 0) throw new ProjectReviewError("INVALID", "预算上限须为大于 0 的整数金额。")
      const value = record(await json(`${base}/budget`, {
        method: "POST",
        body: { costLimitFen },
        signal,
      }))
      const budget = record(value.budget)
      if (typeof budget.costLimitFen !== "number") throw invalidResponse()
      return budget as unknown as ProjectBudgetView
    },
    /** GET /api/projects/[id]/materials — includes sha256 for the frozen material refs. */
    async listMaterials(signal?: AbortSignal): Promise<ProjectReviewMaterial[]> {
      const value = record(await json(`${base}/materials`, { signal }))
      if (!Array.isArray(value.materials)) throw invalidResponse()
      return value.materials as ProjectReviewMaterial[]
    },
    /** GET /api/tasks?projectId= — current account's tasks in this project. */
    async listTasks(signal?: AbortSignal): Promise<ProjectTaskView[]> {
      const value = record(await json(`${taskBase}?projectId=${encodeURIComponent(options.projectId)}`, { signal }))
      if (!Array.isArray(value.tasks)) throw invalidResponse()
      return value.tasks.map(taskView)
    },
    async getTask(id: string, signal?: AbortSignal): Promise<ProjectTaskView> {
      return taskView(await json(`${taskBase}/${encodeURIComponent(id)}`, { signal }))
    },
    /**
     * POST /api/tasks with the same Idempotency-Key the caller keeps for one
     * submission signature; a network repeat reuses the persisted task.
     */
    async submitReview(input: ReviewSubmission, operationId: string, signal?: AbortSignal) {
      checkEditable()
      const value = record(await json(taskBase, {
        method: "POST",
        headers: { "Idempotency-Key": operationId },
        body: {
          kind: "contract-review",
          projectId: options.projectId,
          refs: { materials: input.materials },
          conditions: input.conditions,
        },
        signal,
      }))
      return { task: taskView(value.task), created: value.created !== false }
    },
    /** GET /api/projects/[id]/results — project results are readable by any member. */
    async listResults(signal?: AbortSignal): Promise<ProjectResultView[]> {
      const value = await json(`${base}/results`, { signal })
      if (!Array.isArray(value)) throw invalidResponse()
      return value.map(resultView)
    },
    async getResult(resultId: string, versionId?: string, signal?: AbortSignal): Promise<ProjectResultView> {
      const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""
      return resultView(await json(`${base}/results/${encodeURIComponent(resultId)}${query}`, { signal }))
    },
    /** POST .../validate — a read-side check; allowed for a read-only member. */
    async validateResult(input: { resultId: string; versionId: string; sha256: string }, signal?: AbortSignal): Promise<ResultValidation> {
      return validation(await json(`${base}/results/${encodeURIComponent(input.resultId)}/validate`, {
        method: "POST",
        body: { versionId: input.versionId, sha256: input.sha256 },
        signal,
      }))
    },
    /** POST .../review — binds one explicit saved version and decision. */
    async reviewResult(input: { resultId: string; versionId: string; sha256: string; decision: ResultReview["decision"]; comment: string }, signal?: AbortSignal): Promise<ProjectResultView> {
      checkEditable()
      return resultView(await json(`${base}/results/${encodeURIComponent(input.resultId)}/review`, {
        method: "POST",
        body: { versionId: input.versionId, sha256: input.sha256, decision: input.decision, comment: input.comment },
        signal,
      }))
    },
    async listExports(resultId: string, signal?: AbortSignal): Promise<ExportRef[]> {
      const value = await json(`${base}/results/${encodeURIComponent(resultId)}/exports`, { signal })
      if (!Array.isArray(value)) throw invalidResponse()
      return value as ExportRef[]
    },
    /** POST .../exports — creates an immutable export snapshot for one saved version. */
    async createExport(input: { resultId: string; versionId: string; sha256: string }, signal?: AbortSignal): Promise<ExportRef> {
      checkEditable()
      const value = record(await json(`${base}/results/${encodeURIComponent(input.resultId)}/exports`, {
        method: "POST",
        body: { versionId: input.versionId, sha256: input.sha256 },
        signal,
      }))
      if (typeof value.exportId !== "string") throw invalidResponse()
      return value as unknown as ExportRef
    },
    async downloadExport(resultId: string, exportId: string, signal?: AbortSignal): Promise<Blob> {
      const response = await send(`${base}/results/${encodeURIComponent(resultId)}/exports/${encodeURIComponent(exportId)}/content`, { signal })
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim()
      const blob = await response.blob()
      check(signal)
      if (type !== DOCX_TYPE || !blob.size) throw new ProjectReviewError("UNAVAILABLE", "导出文件响应无效，请重试。")
      return blob
    },
  }
}

export type ProjectReviewsClient = ReturnType<typeof createProjectReviewsClient>
