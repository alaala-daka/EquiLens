import type { ResultReview, ResultValidation, ExportRef } from "./contracts"
import {
  VERIFICATION_RESULT_KINDS,
  type RequirementSetValue,
  type VerificationExternalRecordView,
  type VerificationListSummary,
  type VerificationStaleState,
} from "./verification-types"
import type { VerificationFieldKey } from "./verification-fields"
import type { ProjectBudgetView } from "./reviews-client"
import { DOCX_TYPE } from "../documents/types"

export type { ProjectBudgetView }

/**
 * Project bid-verification client (round-five C4-UI).
 *
 * Consumes the existing round-three task/result/export HTTP surface and the
 * round-four verification surface only:
 * - POST/GET /api/tasks for `bid-requirements` / `bid-verification` tasks
 * - GET /api/projects/[id]/verifications and /[resultId]
 * - POST /api/projects/[id]/verifications/requirements (server-owned save)
 * - POST /api/projects/[id]/verifications/[resultId]/external-records
 * - GET/POST …/materials/[materialId]/versions/[versionId]/fields
 * - result validate/review, exports list/create/content, admin budget
 *
 * The browser never builds a manifest, model address, price, budget or result
 * value for machine kinds. Writes are refused locally for a read-only member,
 * every failure is reported once (no automatic retry of external sends), and a
 * response from another project or an unmounted workspace is rejected.
 */

export type VerificationTaskKind = "bid-requirements" | "bid-verification"

export type VerificationMaterial = {
  id: string
  title: string
  fileName: string | null
  format: "docx" | "pdf" | "image"
  versionId: string
  sha256: string
  parseTaskId: string | null
  parseState: string | null
  snapshotId: string | null
  coverage: null | {
    status: "available" | "partial" | "failed"
    textLength: number
    pageCount: number | null
    findings: { code: string; location: string }[]
  }
  size: number
  createdAt: string
}

export type VerificationTaskState = "queued" | "running" | "success" | "partial" | "failed" | "cancelled"

/** TaskView as returned by the shared task HTTP contract. */
export type VerificationTaskView = {
  id: string
  kind: string
  projectId: string
  state: VerificationTaskState
  stage: string
  createdAt: string
  updatedAt: string
  attempt: number
  maxAttempts: number
  callsUsed: number
  maxCalls: number
  elapsedMs: number
  manifest: {
    version?: number
    catalogVersion?: number
    kind?: string
    projectId?: string
    refs?: Record<string, unknown>
    conditions?: Record<string, unknown>
    submittedBy?: string
    submittedAt?: string
  }
  error: { code: string; message: string } | null
  resultSummary: string | null
}

/** ResultView returned by the shared result HTTP contract. */
export type VerificationResultView = {
  projectId: string
  resultId: string
  versionId: string
  sha256: string
  kind: string
  value: unknown
  machineOutput: unknown
  origin: string
  sources: { fragmentId: string; snapshotId: string; quote: string }[]
  dependencies: { kind: string; id: string; versionId: string }[]
  provenance: { taskId: string; attempt: number; manifest: unknown; manifestHash: string } | null
  validation: ResultValidation
  review: ResultReview | null
  createdAt: string
  createdBy: string
  reason: string
}

/** GET /api/projects/[id]/verifications/[resultId]. */
export type VerificationDetail = {
  result: VerificationResultView
  records: VerificationExternalRecordView[]
  stale: VerificationStaleState
}

/** Client view of a certificate field returned by the fields route. */
export type VerificationFieldView = {
  id: string
  materialId: string
  versionId: string
  subjectKey: string
  fieldKey: VerificationFieldKey
  label: string
  valueText: string
  normalizedValue: string
  origin: "ocr" | "manual" | "material_text"
  support: "ocr" | "material_text" | "pending"
  sourceSnapshotId: string | null
  sourceFragmentId: string | null
  ocrRunId: string | null
  confidence: number | null
  revision: number
  previousId: string | null
  supersededAt: string | null
  reason: string | null
  createdBy: string
  createdAt: string
}

export type ManualFieldWriteInput = {
  fieldKey: VerificationFieldKey
  valueText: string
  subjectKey?: string
  sourceFragmentId?: string | null
}

export type VerificationFailureCode =
  | "ABORTED"
  | "SESSION_INVALID"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "FAILED"

/** Provider-neutral verification failure; the safe server message is preserved. */
export class VerificationClientError extends Error {
  readonly code: VerificationFailureCode
  readonly status: number
  readonly serverCode?: string

  constructor(code: VerificationFailureCode, message: string, options: { status?: number; serverCode?: string } = {}) {
    super(message)
    this.name = "VerificationClientError"
    this.code = code
    this.status = options.status ?? 0
    this.serverCode = options.serverCode
  }
}

const fallbackMessages: Record<number, string> = {
  400: "请求内容无效，请检查后重试。",
  401: "会话已失效，请重新登录。",
  403: "无权执行该操作。",
  404: "找不到对应的核验成果或材料。",
  409: "当前状态已变化，请重新读取后重试。",
  413: "请求内容过大。",
  415: "请求格式无效。",
  422: "提交内容未通过校验，请检查后重试。",
  429: "请求过于频繁，请稍后重试。",
  503: "服务暂不可用，请稍后重试。",
}

const codesByStatus: Record<number, VerificationFailureCode> = {
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
    // Only fixed, safe product strings are surfaced; HTML/control characters fall back.
    ...(typeof message === "string" && message.trim() && message.length <= 300 && !/[\u0000-\u001f<>]/.test(message) ? { message } : {}),
  }
}

/** Map an HTTP failure to the shared client vocabulary; the server product message wins. */
export function verificationFailureFromResponse(status: number, body: unknown): VerificationClientError {
  const details = serverError(body)
  const code = codesByStatus[status] ?? "FAILED"
  const message = details.message ?? fallbackMessages[status] ?? "请求失败，请稍后重试。"
  return new VerificationClientError(code, message, { status, serverCode: details.code })
}

function invalidResponse(): VerificationClientError {
  return new VerificationClientError("FAILED", "服务返回内容无效，请重试。")
}

function isAbort(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && (failure as { name?: unknown }).name === "AbortError"
}

export type VerificationClientOptions = {
  projectId: string
  /** False after unmount, project switch or access pause; late responses become ABORTED. */
  isCurrent: () => boolean
  /** False for a read-only member: writes are refused before any request is sent. */
  canEdit?: () => boolean
  /** True only for a project administrator: budget reads/writes are refused locally otherwise. */
  canManage?: () => boolean
  onAccessInvalid?: (failure: VerificationClientError) => void
  fetch?: typeof fetch
}

type RequestInit = {
  method?: "GET" | "POST"
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type VerificationTaskSubmission =
  | {
    kind: "bid-requirements"
    refs: { materials: Array<{ materialVersionId: string; sha256: string }> }
    conditions: { asOf?: string; externalProcessingConsent: true }
  }
  | {
    kind: "bid-verification"
    refs: {
      materials: Array<{ materialVersionId: string; sha256: string }>
      requirementSet: { id: string; versionId: string; sha256: string }
      externalRecords: Array<{ recordId: string; sha256: string }>
    }
    conditions: { asOf: string }
  }

function expectedKind(kind: string): kind is VerificationTaskKind {
  return kind === "bid-requirements" || kind === "bid-verification"
}

export function createVerificationsClient(options: VerificationClientOptions) {
  const transport = options.fetch ?? fetch
  const base = `/api/projects/${encodeURIComponent(options.projectId)}`

  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new VerificationClientError("ABORTED", "操作已取消。")
  }

  function checkEditable() {
    if (options.canEdit?.() === false) throw new VerificationClientError("ACCESS_DENIED", "只读成员不能执行此操作。")
  }

  function checkManage() {
    if (options.canManage?.() === false) throw new VerificationClientError("ACCESS_DENIED", "只有项目管理员可以登记模型调用预算。")
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
      if (init.signal?.aborted || isAbort(failure)) throw new VerificationClientError("ABORTED", "操作已取消。")
      check(init.signal)
      throw new VerificationClientError("FAILED", "网络连接失败，请重试。")
    }
    check(init.signal)
    if (!response.ok) {
      let detail: unknown = null
      try { detail = await response.json() } catch { detail = null }
      check(init.signal)
      const failure = verificationFailureFromResponse(response.status, detail)
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

  /** Non-throwing kind probe: the shared project task list also contains unrelated kinds. */
  function rawTaskKind(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const kind = (value as { kind?: unknown }).kind
    return typeof kind === "string" ? kind : null
  }

  /** Strict builder for a task id the UI actually references. */
  function taskView(value: unknown): VerificationTaskView {
    const task = record(value)
    if (typeof task.id !== "string" || typeof task.state !== "string" || typeof task.createdAt !== "string" || typeof task.kind !== "string") throw invalidResponse()
    if (!expectedKind(task.kind)) throw invalidResponse()
    return task as unknown as VerificationTaskView
  }

  function resultView(value: unknown): VerificationResultView {
    const result = record(value)
    if (typeof result.resultId !== "string" || typeof result.versionId !== "string" || typeof result.sha256 !== "string" || typeof result.kind !== "string") throw invalidResponse()
    return result as unknown as VerificationResultView
  }

  function validation(value: unknown): ResultValidation {
    const checked = record(value)
    if (!["valid", "invalid", "partial"].includes(String(checked.status)) || typeof checked.versionId !== "string" || !Array.isArray(checked.issues)) throw invalidResponse()
    return checked as unknown as ResultValidation
  }

  function detail(value: unknown): VerificationDetail {
    const view = record(value)
    if (!view.result || !Array.isArray(view.records) || !view.stale || typeof view.stale !== "object") throw invalidResponse()
    return { result: resultView(view.result), records: view.records as VerificationExternalRecordView[], stale: view.stale as VerificationStaleState }
  }

  function fieldList(value: unknown): { fields: VerificationFieldView[]; history: VerificationFieldView[] } {
    const view = record(value)
    if (!Array.isArray(view.fields) || !Array.isArray(view.history)) throw invalidResponse()
    return { fields: view.fields as VerificationFieldView[], history: view.history as VerificationFieldView[] }
  }

  function budget(value: unknown): ProjectBudgetView | null {
    const view = record(value)
    if (!("budget" in view)) throw invalidResponse()
    if (view.budget === null) return null
    const entry = record(view.budget)
    if (typeof entry.costLimitFen !== "number" || typeof entry.remainingFen !== "number") throw invalidResponse()
    return entry as unknown as ProjectBudgetView
  }

  const taskBase = "/api/tasks"
  return {
    /** GET /api/projects/[id]/materials — digest is needed for the frozen material refs. */
    async listMaterials(signal?: AbortSignal): Promise<VerificationMaterial[]> {
      const value = record(await json(`${base}/materials`, { signal }))
      if (!Array.isArray(value.materials)) throw invalidResponse()
      return value.materials as VerificationMaterial[]
    },
    /** GET /api/tasks?projectId= — current account's C4 tasks; other project kinds are ignored. */
    async listTasks(signal?: AbortSignal): Promise<VerificationTaskView[]> {
      const value = record(await json(`${taskBase}?projectId=${encodeURIComponent(options.projectId)}`, { signal }))
      if (!Array.isArray(value.tasks)) throw invalidResponse()
      return value.tasks
        .filter(item => {
          const kind = rawTaskKind(item)
          return kind !== null && expectedKind(kind)
        })
        .map(taskView)
    },
    async getTask(id: string, signal?: AbortSignal): Promise<VerificationTaskView> {
      return taskView(await json(`${taskBase}/${encodeURIComponent(id)}`, { signal }))
    },
    /**
     * POST /api/tasks with one Idempotency-Key per submission input; the caller
     * keeps the key for retries so an uncertain network failure cannot create a
     * second paid task.
     */
    async submitTask(submission: VerificationTaskSubmission, operationId: string, signal?: AbortSignal) {
      checkEditable()
      const value = record(await json(taskBase, {
        method: "POST",
        headers: { "Idempotency-Key": operationId },
        body: {
          kind: submission.kind,
          projectId: options.projectId,
          refs: submission.refs,
          conditions: submission.conditions,
        },
        signal,
      }))
      return { task: taskView(value.task), created: value.created !== false }
    },
    /** GET /api/projects/[id]/verifications — both C4 result kinds with honest stale hints. */
    async listVerifications(signal?: AbortSignal): Promise<VerificationListSummary[]> {
      const value = record(await json(`${base}/verifications`, { signal }))
      if (!Array.isArray(value.items)) throw invalidResponse()
      return value.items as VerificationListSummary[]
    },
    async getVerification(resultId: string, signal?: AbortSignal): Promise<VerificationDetail> {
      return detail(await json(`${base}/verifications/${encodeURIComponent(resultId)}`, { signal }))
    },
    /**
     * POST /api/projects/[id]/verifications/requirements — the only write path
     * for a requirement set; the server re-reads every citation before saving.
     */
    async saveRequirementSet(input: { resultId?: string; baseVersionId: string; operationId: string; reason: string; value: RequirementSetValue }, signal?: AbortSignal): Promise<VerificationResultView> {
      checkEditable()
      const value = record(await json(`${base}/verifications/requirements`, {
        method: "POST",
        body: {
          ...(input.resultId ? { resultId: input.resultId } : {}),
          baseVersionId: input.baseVersionId,
          operationId: input.operationId,
          reason: input.reason,
          value: input.value,
        },
        signal,
      }))
      return resultView(value)
    },
    /** POST …/verifications/[resultId]/external-records — append-only manual evidence. */
    async appendExternalRecord(resultId: string, input: {
      versionId: string
      sha256: string
      requirementId: string
      subject: string
      certificateNo: string
      source: string
      queriedAt: string
      queryConditions: string
      conclusion: VerificationExternalRecordView["conclusion"]
      proofMaterialVersionId: string
    }, signal?: AbortSignal): Promise<VerificationExternalRecordView> {
      checkEditable()
      const value = record(await json(`${base}/verifications/${encodeURIComponent(resultId)}/external-records`, {
        method: "POST",
        body: input,
        signal,
      }))
      if (typeof value.recordId !== "string" || typeof value.sha256 !== "string") throw invalidResponse()
      return value as unknown as VerificationExternalRecordView
    },
    /** GET …/materials/[materialId]/versions/[versionId]/fields — current values and history. */
    async listFields(materialId: string, versionId: string, signal?: AbortSignal) {
      return fieldList(await json(`${base}/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}/fields`, { signal }))
    },
    /** POST the same path — insert-only manual registration/correction with reason support. */
    async registerFields(materialId: string, versionId: string, input: { operationId: string; reason?: string; fields: ManualFieldWriteInput[] }, signal?: AbortSignal) {
      checkEditable()
      const value = record(await json(`${base}/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}/fields`, {
        method: "POST",
        body: { operationId: input.operationId, ...(input.reason ? { reason: input.reason } : {}), fields: input.fields },
        signal,
      }))
      if (!Array.isArray(value.fields)) throw invalidResponse()
      return { fields: value.fields as VerificationFieldView[] }
    },
    /** POST .../results/[resultId]/validate — a read-side check allowed for every member. */
    async validateResult(input: { resultId: string; versionId: string; sha256: string }, signal?: AbortSignal): Promise<ResultValidation> {
      return validation(await json(`${base}/results/${encodeURIComponent(input.resultId)}/validate`, {
        method: "POST",
        body: { versionId: input.versionId, sha256: input.sha256 },
        signal,
      }))
    },
    /** POST .../results/[resultId]/review — binds one explicit saved version and decision. */
    async reviewResult(input: { resultId: string; versionId: string; sha256: string; decision: ResultReview["decision"]; comment: string }, signal?: AbortSignal): Promise<VerificationResultView> {
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
    /** POST .../exports — only kinds with a production template (`bid-verification`). */
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
      if (type !== DOCX_TYPE || !blob.size) throw new VerificationClientError("UNAVAILABLE", "导出文件响应无效，请重试。")
      return blob
    },
    /** GET /api/projects/[id]/budget — administrator-only paid-call ceiling. */
    async getBudget(signal?: AbortSignal): Promise<ProjectBudgetView | null> {
      checkManage()
      return budget(await json(`${base}/budget`, { signal }))
    },
    /** POST /api/projects/[id]/budget — register/update the ceiling. */
    async registerBudget(costLimitFen: number, signal?: AbortSignal): Promise<ProjectBudgetView> {
      checkManage()
      if (!Number.isSafeInteger(costLimitFen) || costLimitFen <= 0) throw new VerificationClientError("INVALID", "预算上限须为大于 0 的整数金额。")
      const value = record(await json(`${base}/budget`, { method: "POST", body: { costLimitFen }, signal }))
      const entry = record(value.budget)
      if (typeof entry.costLimitFen !== "number") throw invalidResponse()
      return entry as unknown as ProjectBudgetView
    },
  }
}

export type VerificationsClient = ReturnType<typeof createVerificationsClient>

/** Kinds this client may submit; kept explicit so a future kind cannot be submitted accidentally. */
export const VERIFICATION_TASK_KINDS: readonly VerificationTaskKind[] = ["bid-requirements", "bid-verification"]
export const VERIFICATION_KINDS = VERIFICATION_RESULT_KINDS
