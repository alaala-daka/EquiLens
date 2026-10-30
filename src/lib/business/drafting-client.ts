import type { ExportRef, ResultReview, ResultValidation } from "./contracts"
import type { ProjectResultView, ProjectReviewMaterial } from "./reviews-client"
import { ProjectReviewError, reviewFailureFromResponse } from "./reviews-client"
import { DOCX_TYPE } from "../documents/types"

export type { ProjectResultView, ProjectReviewMaterial } from "./reviews-client"

/**
 * C5 project drafting client (spec 01 §8.2.4, plan §5 C5).
 *
 * Consumes only the frozen drafting HTTP contract: proposed-input versions,
 * draft generation/revision through the server-owned drafting service, and the
 * existing shared results/exports routes for reading, validating, reviewing and
 * exporting saved drafts. It never submits sources, dependencies, rendered
 * paragraphs, template content or a result kind; the server template catalogue
 * remains the single authority. Read-only members can read/download existing
 * drafts but all writes are refused locally before any request is sent.
 */
export type DraftingKind = "specialty-subcontract" | "supplementary-agreement"
export type DraftingTemplateStatus = "待核对"

export type DraftingTemplateFieldView = {
  id: string
  label: string
  section: string
  kind: "text" | "amount" | "date" | "choice"
  required: "always" | { when: { fieldId: string; equals: string } }
  source: "proposed"
  maxLength: number
  choices?: Array<{ value: string; label: string }>
}

export type DraftingOriginalContractRule = {
  required: true
  allowed: Array<{ kind: "material" | "result"; resultKind?: DraftingKind }>
}

export type DraftingTemplateView = {
  id: string
  kind: DraftingKind
  version: string
  sha256: string
  status: DraftingTemplateStatus
  label: string
  summary: string
  sections: Array<{ id: string; title: string }>
  fields: DraftingTemplateFieldView[]
  originalContract: DraftingOriginalContractRule | null
  renderVersion: string
}

export type DraftingOriginalContractRef = {
  kind: "material" | "result"
  id: string
  versionId: string
  title: string
  sha256?: string
}

export type DraftingMissingFieldView = { fieldId: string; label: string; section: string; reason: "required" | "conditional" }

export type DraftingInputSummaryView = {
  inputId: string
  kind: DraftingKind
  templateId: string
  templateLabel: string
  templateStatus: DraftingTemplateStatus
  templateVersion: string
  templateSha256: string
  version: number
  versionId: string
  sha256: string
  createdAt: string
  createdBy: string
  missingCount: number
  originalContractTitle: string | null
}

export type DraftingInputDetailView = DraftingInputSummaryView & {
  values: Record<string, string>
  originalContract: DraftingOriginalContractRef | null
  missing: DraftingMissingFieldView[]
}

export type DraftingInputView = { input: DraftingInputDetailView; template: DraftingTemplateView }
export type DraftingInputsView = { templates: DraftingTemplateView[]; inputs: DraftingInputSummaryView[] }

export type DraftingValueFieldView = {
  fieldId: string
  label: string
  section: string
  kind: DraftingTemplateFieldView["kind"]
  source: "proposed"
  value: string
}

export type DraftingValueView = {
  schemaVersion: 1
  kind: DraftingKind
  status: "partial"
  template: { id: string; version: string; sha256: string; status: DraftingTemplateStatus }
  input: { inputId: string; versionId: string; version: number; sha256: string }
  fields: DraftingValueFieldView[]
  originalContract: DraftingOriginalContractRef | null
  missing: DraftingMissingFieldView[]
  paragraphs: string[]
  warnings: Array<{ code: string; message: string }>
  renderVersion: string
}

const DRAFTING_KINDS: readonly string[] = ["specialty-subcontract", "supplementary-agreement"]

export function isDraftingResultKind(kind: unknown): kind is DraftingKind {
  return typeof kind === "string" && DRAFTING_KINDS.includes(kind)
}

export type ProjectDraftingClientOptions = {
  projectId: string
  /** False after unmount, project switch or access pause; late responses become ABORTED. */
  isCurrent: () => boolean
  /** False for a read-only member: write calls are refused before any request is sent. */
  canEdit?: () => boolean
  onAccessInvalid?: (failure: ProjectReviewError) => void
  fetch?: typeof fetch
}

type RequestInit = { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }

export function createProjectDraftingClient(options: ProjectDraftingClientOptions) {
  const transport = options.fetch ?? fetch
  const base = `/api/projects/${encodeURIComponent(options.projectId)}`

  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new ProjectReviewError("ABORTED", "操作已取消。")
  }

  function checkEditable() {
    if (options.canEdit?.() === false) throw new ProjectReviewError("ACCESS_DENIED", "只读成员不能执行此操作。")
  }

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    check(init.signal)
    const headers: Record<string, string> = {}
    let body: string | undefined
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(init.body)
    }
    let response: Response
    try {
      response = await transport(path, {
        method: init.method ?? "GET", cache: "no-store", credentials: "same-origin", headers,
        ...(body === undefined ? {} : { body }), signal: init.signal,
      })
    } catch (failure) {
      if (init.signal?.aborted || (typeof failure === "object" && failure !== null && (failure as { name?: unknown }).name === "AbortError")) {
        throw new ProjectReviewError("ABORTED", "操作已取消。")
      }
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

  function invalidResponse(): ProjectReviewError {
    return new ProjectReviewError("FAILED", "服务返回内容无效，请重试。")
  }

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse()
    return value as Record<string, unknown>
  }

  function templateView(value: unknown): DraftingTemplateView {
    const template = record(value)
    if (typeof template.id !== "string" || typeof template.kind !== "string" || !DRAFTING_KINDS.includes(template.kind) ||
      typeof template.version !== "string" || typeof template.sha256 !== "string" || template.status !== "待核对" ||
      !Array.isArray(template.sections) || !Array.isArray(template.fields)) throw invalidResponse()
    return template as unknown as DraftingTemplateView
  }

  function inputView(value: unknown): DraftingInputView {
    const view = record(value)
    const input = record(view.input)
    if (typeof input.inputId !== "string" || typeof input.versionId !== "string" || typeof input.sha256 !== "string" ||
      typeof input.version !== "number" || !record(input.values) || !Array.isArray(input.missing)) throw invalidResponse()
    return { input: input as unknown as DraftingInputDetailView, template: templateView(view.template) }
  }

  function resultView(value: unknown): ProjectResultView {
    const result = record(value)
    if (typeof result.resultId !== "string" || typeof result.versionId !== "string" || typeof result.sha256 !== "string" ||
      typeof result.kind !== "string") throw invalidResponse()
    return result as unknown as ProjectResultView
  }

  function validationView(value: unknown): ResultValidation {
    const checked = record(value)
    if (!["valid", "invalid", "partial"].includes(String(checked.status)) || typeof checked.versionId !== "string" || !Array.isArray(checked.issues)) throw invalidResponse()
    return checked as unknown as ResultValidation
  }

  return {
    /** GET /api/projects/[id]/drafting-inputs — code templates plus the project's saved inputs. */
    async listInputs(signal?: AbortSignal): Promise<DraftingInputsView> {
      const value = record(await json(`${base}/drafting-inputs`, { signal }))
      if (!Array.isArray(value.templates) || !Array.isArray(value.inputs)) throw invalidResponse()
      return {
        templates: value.templates.map(templateView),
        inputs: value.inputs as DraftingInputSummaryView[],
      }
    },
    /** GET .../drafting-inputs/[inputId] — current version detail with values and missing list. */
    async getInput(inputId: string, signal?: AbortSignal): Promise<DraftingInputView> {
      return inputView(await json(`${base}/drafting-inputs/${encodeURIComponent(inputId)}`, { signal }))
    },
    /** GET /api/projects/[id]/materials — project materials available as the original contract. */
    async listMaterials(signal?: AbortSignal): Promise<ProjectReviewMaterial[]> {
      const value = record(await json(`${base}/materials`, { signal }))
      if (!Array.isArray(value.materials)) throw invalidResponse()
      return value.materials as ProjectReviewMaterial[]
    },
    /** POST .../drafting-inputs — append one immutable proposed-input version. */
    async saveInput(input: {
      templateId: string
      inputId?: string
      baseVersionId: string
      operationId: string
      fields: Record<string, string>
      originalContract?: DraftingOriginalContractRef
    }, signal?: AbortSignal): Promise<DraftingInputView> {
      checkEditable()
      return inputView(await json(`${base}/drafting-inputs`, {
        method: "POST",
        body: {
          templateId: input.templateId,
          ...(input.inputId ? { inputId: input.inputId } : {}),
          baseVersionId: input.baseVersionId,
          operationId: input.operationId,
          fields: input.fields,
          ...(input.originalContract ? { originalContract: input.originalContract } : {}),
        },
        signal,
      }))
    },
    /** POST .../drafts — deterministic render saved as a partial server-owned draft result. */
    async generateDraft(input: { inputId: string; versionId: string; sha256: string; operationId: string; reason: string }, signal?: AbortSignal): Promise<ProjectResultView> {
      checkEditable()
      return resultView(await json(`${base}/drafts`, {
        method: "POST",
        body: { inputId: input.inputId, versionId: input.versionId, sha256: input.sha256, operationId: input.operationId, reason: input.reason },
        signal,
      }))
    },
    /** POST .../drafts/[resultId]/revisions — re-render onto a new immutable draft version (review resets). */
    async reviseDraft(resultId: string, input: {
      baseVersionId: string; inputId: string; versionId: string; sha256: string; operationId: string; reason: string
    }, signal?: AbortSignal): Promise<ProjectResultView> {
      checkEditable()
      return resultView(await json(`${base}/drafts/${encodeURIComponent(resultId)}/revisions`, {
        method: "POST",
        body: {
          baseVersionId: input.baseVersionId, inputId: input.inputId, versionId: input.versionId,
          sha256: input.sha256, operationId: input.operationId, reason: input.reason,
        },
        signal,
      }))
    },
    /** GET /api/projects/[id]/results — project-readable drafts only (other result kinds filtered out). */
    async listDrafts(signal?: AbortSignal): Promise<ProjectResultView[]> {
      const value = await json(`${base}/results`, { signal })
      if (!Array.isArray(value)) throw invalidResponse()
      return (value as unknown[]).map(resultView).filter(result => isDraftingResultKind(result.kind))
    },
    async getDraft(resultId: string, versionId?: string, signal?: AbortSignal): Promise<ProjectResultView> {
      const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""
      return resultView(await json(`${base}/results/${encodeURIComponent(resultId)}${query}`, { signal }))
    },
    /** POST .../results/[resultId]/validate — read-side revalidation, allowed for viewers. */
    async validateDraft(input: { resultId: string; versionId: string; sha256: string }, signal?: AbortSignal): Promise<ResultValidation> {
      return validationView(await json(`${base}/results/${encodeURIComponent(input.resultId)}/validate`, {
        method: "POST", body: { versionId: input.versionId, sha256: input.sha256 }, signal,
      }))
    },
    /**
     * POST .../results/[resultId]/review — binds one saved version. The UI only
     * offers reject / request-changes; approval is rejected by the server because
     * a 待核对 template draft is always partial.
     */
    async reviewDraft(input: { resultId: string; versionId: string; sha256: string; decision: ResultReview["decision"]; comment: string }, signal?: AbortSignal): Promise<ProjectResultView> {
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
    /** POST .../results/[resultId]/exports — immutable export snapshot of one saved draft version. */
    async createExport(input: { resultId: string; versionId: string; sha256: string }, signal?: AbortSignal): Promise<ExportRef> {
      checkEditable()
      const value = record(await json(`${base}/results/${encodeURIComponent(input.resultId)}/exports`, {
        method: "POST", body: { versionId: input.versionId, sha256: input.sha256 }, signal,
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

export type ProjectDraftingClient = ReturnType<typeof createProjectDraftingClient>
