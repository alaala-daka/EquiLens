import type { AuthIdentity } from "../auth/service"
import type { MaterialRepository } from "../materials/repository"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultDependency, ResultService, ResultView } from "../results/service"
import {
  draftingTemplateById, draftingTemplateForKind, draftingTemplateView, missingFields,
  type DraftingKind, type DraftingTemplate, type DraftingTemplateView,
} from "../templates/catalog"
import {
  DraftingInputRepository, type DraftingInputRecord, type DraftingInputVersionRecord,
} from "../templates/repository"
import { normalizeDraftingInput, payloadRequestHash, payloadSha256, valuesFromPayload, type DraftingInputPayload } from "./payload"
import { renderDraft, type DraftingOriginalContractRef } from "./render"
import { buildDraftingValue, isDraftingKind, type DraftingValue } from "./value"
import { specialtySubcontractValidator, supplementaryAgreementValidator } from "./validation"

/**
 * C5 drafting service (spec 01 §4.4/§8.2.4, plan §4.3/§5 C5).
 *
 * - `saveInput` persists one immutable proposed-input version (template-scoped
 *   field allowlist, amount/date/choice validation, optional/required original
 *   contract pin, idempotent operation ids, stale-base CONFLICT).
 * - `generateDraft` deterministically re-renders the template from a pinned
 *   input version and saves a `partial` human-authored result through the
 *   production server-owned ResultService (the only write path for
 *   specialty-subcontract / supplementary-agreement values). No model call.
 * - `reviseDraft` re-renders from a new pinned input version onto an existing
 *   draft result, creating a new immutable version and resetting the whole
 *   result review (new versions start unreviewed).
 *
 * Fixed "待核对" templates mean every draft is `partial` with a
 * TEMPLATE_UNREVIEWED warning; approval as a complete result is impossible.
 */
export type SaveDraftingInputInput = {
  projectId: string
  templateId: string
  inputId?: string
  baseVersionId: string
  operationId: string
  fields: unknown
  originalContract?: unknown
}

export type GenerateDraftInput = {
  projectId: string
  inputId: string
  versionId: string
  sha256: string
  operationId: string
  reason: string
}

export type ReviseDraftInput = GenerateDraftInput & { resultId: string; baseVersionId: string }

export type DraftingInputSummary = {
  inputId: string
  kind: DraftingKind
  templateId: string
  templateLabel: string
  templateStatus: "待核对"
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

export type DraftingInputDetail = DraftingInputSummary & {
  values: Record<string, string>
  originalContract: DraftingOriginalContractRef | null
  missing: Array<{ fieldId: string; label: string; section: string; reason: "required" | "conditional" }>
}

export type DraftingInputView = { input: DraftingInputDetail; template: DraftingTemplateView }
export type DraftingInputsView = { templates: DraftingTemplateView[]; inputs: DraftingInputSummary[] }

export type DraftingServiceDependencies = {
  repository: DraftingInputRepository
  materials: Pick<MaterialRepository, "versionById" | "findMaterial">
  results: ResultService
  readProjectRetention: (projectId: string) => Promise<string | null>
  now?: () => Date
}

const MAX_OPERATION = 128
const MAX_REASON = 500
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function statusError(code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "SERVICE_UNAVAILABLE" | "INVALID_SOURCE" | "FORBIDDEN", message: string): never {
  throw new BusinessError(code, message)
}

/** Project retention is stored as a day and the day is inclusive (material/review parity). */
export function retentionExpired(day: string, now: Date): boolean {
  const end = Date.parse(`${day}T00:00:00Z`) + 86_400_000
  return !Number.isFinite(end) || now.getTime() >= end
}

function requireString(value: unknown, max: number, message: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) statusError("INVALID_INPUT", message)
  return value.trim()
}

function requireId(value: unknown, message: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) statusError("INVALID_INPUT", message)
  return value
}

export class DraftingService {
  constructor(private readonly dependencies: DraftingServiceDependencies) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }

  private async assertEditable(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string) {
    const access = await authorize(identity, projectId, "edit")
    if (access.projectId !== projectId || access.role === "viewer") statusError("FORBIDDEN", "无权操作该文书草稿。")
    return access
  }

  private async assertRetention(projectId: string): Promise<void> {
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention) statusError("SERVICE_UNAVAILABLE", "项目保留期限不可用，请稍后重试。")
    if (retentionExpired(retention, this.now())) statusError("INVALID_SOURCE", "项目已超过保留期限，不能保存或生成文书草稿。")
  }

  private templateForPayload(payload: DraftingInputPayload): DraftingTemplate {
    const template = draftingTemplateById(payload.templateId)
    if (!template) statusError("SERVICE_UNAVAILABLE", "该文书模板版本不再可用。")
    if (template.kind !== payload.kind) statusError("CONFLICT", "拟约定输入的文书类型与模板不一致。")
    return template
  }

  private summary(input: DraftingInputRecord, version: DraftingInputVersionRecord): DraftingInputSummary {
    const template = draftingTemplateById(version.payload.templateId)
    const values = valuesFromPayload(version.payload)
    return {
      inputId: input.id,
      kind: version.kind,
      templateId: version.payload.templateId,
      templateLabel: template?.label ?? version.kind,
      templateStatus: "待核对",
      templateVersion: template?.version ?? "",
      templateSha256: template?.sha256 ?? "",
      version: version.version,
      versionId: version.id,
      sha256: version.sha256,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      missingCount: template ? missingFields(template, values).length : 0,
      originalContractTitle: version.payload.originalContract?.title ?? null,
    }
  }

  private detail(input: DraftingInputRecord, version: DraftingInputVersionRecord): DraftingInputDetail {
    const template = draftingTemplateById(version.payload.templateId)
    const values = valuesFromPayload(version.payload)
    return {
      ...this.summary(input, version),
      values,
      originalContract: version.payload.originalContract ? { ...version.payload.originalContract } : null,
      missing: template ? missingFields(template, values).map(item => ({ ...item })) : [],
    }
  }

  private async loadInput(projectId: string, inputId: string): Promise<{ input: DraftingInputRecord; version: DraftingInputVersionRecord }> {
    const input = await this.dependencies.repository.findInput(projectId, inputId)
    if (!input) statusError("NOT_FOUND", "找不到该拟约定输入。")
    const version = await this.dependencies.repository.current(projectId, inputId)
    if (!version) statusError("NOT_FOUND", "找不到该拟约定输入版本。")
    return { input, version }
  }

  /**
   * Resolve and pin the original contract for a supplementary agreement.
   * Only an active in-project material version or a saved in-project
   * `specialty-subcontract` result version is accepted; anything else rejects
   * before an input version is persisted.
   */
  private async resolveOriginalContract(
    identity: AuthIdentity,
    authorize: ResultAuthorizer,
    projectId: string,
    template: DraftingTemplate,
    raw: unknown,
  ): Promise<DraftingOriginalContractRef | null> {
    if (!template.originalContract) {
      if (raw !== undefined && raw !== null) statusError("INVALID_INPUT", "该文书模板不需要原合同版本引用。")
      return null
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) statusError("INVALID_INPUT", "补充协议必须固定本项目原合同版本。")
    const record = raw as Record<string, unknown>
    const allowedKeys = record.kind === "material" ? ["kind", "materialId", "versionId"] : record.kind === "result" ? ["kind", "resultId", "versionId"] : []
    if (!allowedKeys.length || Object.keys(record).some(key => !allowedKeys.includes(key))) {
      statusError("INVALID_INPUT", "原合同版本引用无效。")
    }
    const versionId = requireId(record.versionId, "原合同版本引用无效。")
    if (record.kind === "material") {
      const materialId = requireId(record.materialId, "原合同版本引用无效。")
      const version = await this.dependencies.materials.versionById(projectId, versionId)
      if (!version || version.materialId !== materialId) statusError("INVALID_INPUT", "原合同材料版本不属于本项目或不可用。")
      const material = await this.dependencies.materials.findMaterial(projectId, version.materialId)
      if (!material || material.status !== "active" || !material.processingAuthorized) statusError("INVALID_INPUT", "原合同材料版本不可用。")
      if (retentionExpired(material.retentionUntil, this.now())) statusError("INVALID_SOURCE", "原合同材料已超过保留期限。")
      return { kind: "material", id: material.id, versionId: version.id, title: material.title, sha256: version.sha256 }
    }
    const resultId = requireId(record.resultId, "原合同版本引用无效。")
    const view = await this.dependencies.results.get(identity, authorize, projectId, resultId, versionId)
    if (view.kind !== "specialty-subcontract") statusError("INVALID_INPUT", "原合同必须是本项目的专业分包合同成果。")
    const title = (view.value as { template?: { label?: unknown } } | null)?.template?.label
    return {
      kind: "result", id: view.resultId, versionId: view.versionId,
      title: typeof title === "string" && title.trim() ? title.trim() : "专业分包合同成果",
      sha256: view.sha256,
    }
  }

  async listInputs(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string): Promise<DraftingInputsView> {
    await this.assertEditableForRead(identity, authorize, projectId)
    const rows = await this.dependencies.repository.list(projectId)
    return {
      templates: draftingTemplatesView(),
      inputs: rows.map(row => this.summary(row.input, row.current)),
    }
  }

  private async assertEditableForRead(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string): Promise<void> {
    const access = await authorize(identity, projectId, "read")
    if (access.projectId !== projectId) statusError("FORBIDDEN", "无权读取该项目。")
  }

  async getInput(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, inputId: string): Promise<DraftingInputView> {
    await this.assertEditableForRead(identity, authorize, projectId)
    const { input, version } = await this.loadInput(projectId, requireId(inputId, "拟约定输入标识无效。"))
    const template = this.templateForPayload(version.payload)
    return { input: this.detail(input, version), template: draftingTemplateView(template) }
  }

  async saveInput(identity: AuthIdentity, authorize: ResultAuthorizer, input: SaveDraftingInputInput): Promise<DraftingInputView> {
    await this.assertEditable(identity, authorize, input.projectId)
    await this.assertRetention(input.projectId)
    const template = draftingTemplateById(input.templateId)
    if (!template) statusError("INVALID_INPUT", "文书模板无效。")
    const operationId = requireString(input.operationId, MAX_OPERATION, "提交标识无效。")
    if (!OPERATION_PATTERN.test(operationId)) statusError("INVALID_INPUT", "提交标识无效。")
    const inputId = input.inputId === undefined ? undefined : requireId(input.inputId, "拟约定输入标识无效。")
    let baseVersionId = ""
    if (inputId) baseVersionId = requireId(input.baseVersionId, "基础版本无效。")
    else if (input.baseVersionId !== "") statusError("INVALID_INPUT", "新建拟约定输入不能指定基础版本。")
    const originalContract = await this.resolveOriginalContract(identity, authorize, input.projectId, template, input.originalContract)
    const normalized = normalizeDraftingInput(template, input.fields, originalContract)
    if (normalized.issues.length) statusError("INVALID_INPUT", normalized.issues[0])
    const payload = normalized.payload
    const sha256 = payloadSha256(payload)
    const requestHash = payloadRequestHash(payload, baseVersionId)
    let version: DraftingInputVersionRecord | null
    try {
      version = await this.dependencies.repository.append({
        projectId: input.projectId,
        ...(inputId ? { inputId } : {}),
        expectedBaseVersionId: baseVersionId,
        kind: template.kind,
        operationId,
        requestHash,
        sha256,
        payload,
        createdBy: identity.account.id,
      })
    } catch (failure) {
      if (DraftingInputRepository.isUniqueViolation(failure)) {
        const existing = await this.dependencies.repository.resolveDuplicate(input.projectId, operationId, requestHash)
        if (!existing) throw failure
        version = existing
      } else throw failure
    }
    const { input: record } = await this.loadInput(input.projectId, version.inputId)
    return { input: this.detail(record, version), template: draftingTemplateView(template) }
  }

  private async renderPinned(input: {
    identity: AuthIdentity
    authorize: ResultAuthorizer
    inputId: string
    versionId: string
    sha256: string
    projectId: string
  }): Promise<{ value: DraftingValue; dependencies: ResultDependency[]; template: DraftingTemplate; version: DraftingInputVersionRecord }> {
    const version = await this.dependencies.repository.version(input.projectId, input.inputId, input.versionId)
    if (!version) statusError("NOT_FOUND", "找不到该拟约定输入版本。")
    if (version.sha256 !== input.sha256) statusError("CONFLICT", "拟约定输入版本摘要已变化，请重新读取。")
    const template = this.templateForPayload(version.payload)
    const original = version.payload.originalContract
    if (original) {
      const resolved = await this.resolveOriginalContract(input.identity, input.authorize, input.projectId, template,
        original.kind === "material"
          ? { kind: "material", materialId: original.id, versionId: original.versionId }
          : { kind: "result", resultId: original.id, versionId: original.versionId })
      if (!resolved || resolved.sha256 !== original.sha256) statusError("CONFLICT", "原合同版本摘要已变化，请重新保存拟约定输入。")
    } else {
      await this.resolveOriginalContract(input.identity, input.authorize, input.projectId, template, null)
    }
    const values = valuesFromPayload(version.payload)
    const render = renderDraft({
      template,
      values,
      originalContract: version.payload.originalContract,
      input: { inputId: version.inputId, versionId: version.id, version: version.version, sha256: version.sha256 },
    })
    const value = buildDraftingValue({ template, payload: version.payload, input: { inputId: version.inputId, versionId: version.id, version: version.version, sha256: version.sha256 }, render })
    const validator = template.kind === "specialty-subcontract" ? specialtySubcontractValidator : supplementaryAgreementValidator
    const validated = await validator(value)
    if (validated.status === "invalid") statusError("SERVICE_UNAVAILABLE", "草稿未通过服务端校验，未保存。")
    const dependencies: ResultDependency[] = [{ kind: "template", id: template.id, versionId: template.version }]
    if (value.originalContract) {
      dependencies.push({
        kind: value.originalContract.kind,
        id: value.originalContract.id,
        versionId: value.originalContract.versionId,
      })
    }
    return { value, dependencies, template, version }
  }

  async generateDraft(identity: AuthIdentity, authorize: ResultAuthorizer, input: GenerateDraftInput): Promise<ResultView> {
    await this.assertEditable(identity, authorize, input.projectId)
    await this.assertRetention(input.projectId)
    const operationId = requireString(input.operationId, MAX_OPERATION, "提交标识无效。")
    if (!OPERATION_PATTERN.test(operationId)) statusError("INVALID_INPUT", "提交标识无效。")
    const reason = requireString(input.reason, MAX_REASON, "生成理由无效。")
    const rendered = await this.renderPinned({
      identity, authorize, projectId: input.projectId,
      inputId: requireId(input.inputId, "拟约定输入标识无效。"),
      versionId: requireId(input.versionId, "拟约定输入版本无效。"),
      sha256: requireString(input.sha256, 64, "拟约定输入摘要无效。"),
    })
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId: input.projectId,
      kind: rendered.template.kind,
      baseVersionId: "",
      operationId,
      reason,
      value: rendered.value,
      sources: [],
      dependencies: rendered.dependencies,
    }, undefined, { serverOwned: true })
  }

  async reviseDraft(identity: AuthIdentity, authorize: ResultAuthorizer, input: ReviseDraftInput): Promise<ResultView> {
    await this.assertEditable(identity, authorize, input.projectId)
    await this.assertRetention(input.projectId)
    const operationId = requireString(input.operationId, MAX_OPERATION, "提交标识无效。")
    if (!OPERATION_PATTERN.test(operationId)) statusError("INVALID_INPUT", "提交标识无效。")
    const reason = requireString(input.reason, MAX_REASON, "修订理由无效。")
    const resultId = requireId(input.resultId, "草稿成果标识无效。")
    const baseVersionId = requireId(input.baseVersionId, "草稿基础版本无效。")
    const previous = await this.dependencies.results.get(identity, authorize, input.projectId, resultId, baseVersionId)
    if (!isDraftingKind(previous.kind)) statusError("NOT_FOUND", "找不到该草稿成果。")
    const kindTemplate = draftingTemplateForKind(previous.kind)
    if (!kindTemplate) statusError("SERVICE_UNAVAILABLE", "该文书模板版本不再可用。")
    const rendered = await this.renderPinned({
      identity, authorize, projectId: input.projectId,
      inputId: requireId(input.inputId, "拟约定输入标识无效。"),
      versionId: requireId(input.versionId, "拟约定输入版本无效。"),
      sha256: requireString(input.sha256, 64, "拟约定输入摘要无效。"),
    })
    if (rendered.template.id !== kindTemplate.id) statusError("CONFLICT", "拟约定输入版本与草稿的文书类型不一致。")
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId: input.projectId,
      resultId,
      kind: rendered.template.kind,
      baseVersionId,
      operationId,
      reason,
      value: rendered.value,
      sources: [],
      dependencies: rendered.dependencies,
    }, undefined, { serverOwned: true })
  }
}

function draftingTemplatesView() {
  return [draftingTemplateById("specialty-subcontract-v1")!, draftingTemplateById("supplementary-agreement-v1")!].map(draftingTemplateView)
}
