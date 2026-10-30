import type {
  DraftingInputDetailView, DraftingInputView, DraftingKind, DraftingOriginalContractRef, DraftingTemplateFieldView,
  DraftingTemplateView, DraftingValueView, ProjectDraftingClient, ProjectResultView,
} from "@/lib/business/drafting-client"

/**
 * C5 drafting workspace pure logic (plan §5 C5).
 *
 * Kept free of React and network so the component's form/step/read-only rules
 * can be tested directly. The server remains authoritative for template
 * definition, value validation, deterministic rendering and the partial/
 * TEMPLATE_UNREVIEWED policy; these helpers only shape the form state, block
 * obvious invalid submissions early and decide which step (save input vs
 * generate draft) is available.
 */
export type DraftingForm = {
  templateId: string
  values: Record<string, string>
  originalContract: DraftingOriginalContractRef | null
  /** Saved input pins; empty strings mean "no saved proposed-input version yet". */
  inputId: string
  versionId: string
  version: number
  sha256: string
  /** Fingerprint of the saved values; empty means nothing saved yet. */
  savedFingerprint: string
}

export type DraftingMissingPreview = { fieldId: string; label: string; section: string; reason: "required" | "conditional" }

const AMOUNT = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
export const DRAFTING_STATUS_LABELS = {
  valid: "校验通过",
  partial: "部分完成（待核对模板草稿）",
  invalid: "校验未通过",
} as const
export const DRAFTING_REVIEW_LABELS: Record<string, string> = {
  approved: "已批准",
  rejected: "已驳回",
  changes_requested: "退回修改",
  pending: "待复核",
}
export const DRAFTING_KIND_LABELS: Record<DraftingKind, string> = {
  "specialty-subcontract": "专业分包合同",
  "supplementary-agreement": "补充协议",
}

function sortedValues(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values).filter(([, value]) => Boolean(value.trim())).sort(([left], [right]) => left.localeCompare(right))
}

export function formFingerprint(form: Pick<DraftingForm, "templateId" | "values" | "originalContract">): string {
  return JSON.stringify({
    templateId: form.templateId,
    values: sortedValues(form.values),
    originalContract: form.originalContract
      ? { kind: form.originalContract.kind, id: form.originalContract.id, versionId: form.originalContract.versionId }
      : null,
  })
}

export function emptyDraftingForm(templateId: string): DraftingForm {
  return { templateId, values: {}, originalContract: null, inputId: "", versionId: "", version: 0, sha256: "", savedFingerprint: "" }
}

export function formFromSavedInput(view: DraftingInputView): DraftingForm {
  return {
    templateId: view.template.id,
    values: { ...view.input.values },
    originalContract: view.input.originalContract ? { ...view.input.originalContract } : null,
    inputId: view.input.inputId,
    versionId: view.input.versionId,
    version: view.input.version,
    sha256: view.input.sha256,
    savedFingerprint: formFingerprint({ templateId: view.template.id, values: view.input.values, originalContract: view.input.originalContract }),
  }
}

export function isDraftingFormDirty(form: DraftingForm): boolean {
  const fingerprint = formFingerprint(form)
  if (form.savedFingerprint) return fingerprint !== form.savedFingerprint
  return fingerprint !== formFingerprint({ templateId: form.templateId, values: {}, originalContract: null })
}

export function fieldValueError(field: DraftingTemplateFieldView, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "字段值为空。"
  if (trimmed.length > field.maxLength) return "字段值超过长度上限。"
  if (field.kind === "amount" && !AMOUNT.test(trimmed)) return "金额必须是不超过两位小数的十进制元字符串。"
  if (field.kind === "date" && !isCalendarDate(trimmed)) return "日期必须是有效的 YYYY-MM-DD。"
  if (field.kind === "choice" && !(field.choices ?? []).some(choice => choice.value === trimmed)) return "选项值不在模板允许范围内。"
  return null
}

export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function conditionalFieldIds(template: DraftingTemplateView, values: Record<string, string>): Set<string> {
  const active = new Set<string>()
  for (const field of template.fields) {
    if (field.required === "always") continue
    const condition = field.required.when
    if ((values[condition.fieldId] ?? "").trim() === condition.equals) active.add(field.id)
  }
  return active
}

/** Client preview of the server's missing list; the server value stays authoritative. */
export function missingPreview(template: DraftingTemplateView, values: Record<string, string>): DraftingMissingPreview[] {
  const conditional = conditionalFieldIds(template, values)
  const missing: DraftingMissingPreview[] = []
  for (const field of template.fields) {
    const reason = field.required === "always" ? "required" as const : conditional.has(field.id) ? "conditional" as const : null
    if (!reason) continue
    if (!(values[field.id] ?? "").trim()) missing.push({ fieldId: field.id, label: field.label, section: field.section, reason })
  }
  return missing
}

export function fieldSourceLabel(): string {
  return "人工拟约定输入"
}

export function sectionTitle(template: DraftingTemplateView, sectionId: string): string {
  return template.sections.find(section => section.id === sectionId)?.title ?? sectionId
}

export function fieldsBySection(template: DraftingTemplateView): Array<{ section: { id: string; title: string }; fields: DraftingTemplateFieldView[] }> {
  return template.sections.map(section => ({
    section,
    fields: template.fields.filter(field => field.section === section.id),
  }))
}

export type StepCheck = { ok: boolean; issues: string[] }

/** Save proposed input: template-scoped values, valid amounts/dates/choices, original contract pin for supplementary. */
export function checkSaveInput(template: DraftingTemplateView, form: DraftingForm, canEdit: boolean): StepCheck {
  const issues: string[] = []
  if (!canEdit) issues.push("只读成员不能保存拟约定输入。")
  if (form.templateId !== template.id) issues.push("文书模板已变化，请重新选择。")
  const known = new Set(template.fields.map(field => field.id))
  for (const [fieldId, value] of Object.entries(form.values)) {
    if (!value.trim()) continue
    if (!known.has(fieldId)) { issues.push("拟约定输入包含模板未登记的字段。"); continue }
    const field = template.fields.find(item => item.id === fieldId)!
    const failure = fieldValueError(field, value)
    if (failure) issues.push(`「${field.label}」${failure}`)
  }
  if (template.originalContract && !form.originalContract) issues.push("补充协议必须选择本项目原合同版本。")
  if (!template.originalContract && form.originalContract) issues.push("该文书模板不需要原合同版本。")
  return { ok: issues.length === 0, issues }
}

/** Generate a draft: only from the current saved proposed-input version, never from unsaved edits. */
export function checkGenerateDraft(template: DraftingTemplateView | null, form: DraftingForm, canEdit: boolean): StepCheck {
  const issues: string[] = []
  if (!canEdit) issues.push("只读成员不能生成草稿。")
  if (!template || template.id !== form.templateId) issues.push("请先选择文书模板。")
  if (!form.versionId || !form.inputId) issues.push("请先保存拟约定输入。")
  if (isDraftingFormDirty(form)) issues.push("拟约定输入有未保存修改，请先保存后再生成草稿。")
  if (template?.originalContract && !form.originalContract) issues.push("补充协议必须选择本项目原合同版本。")
  return { ok: issues.length === 0, issues }
}

export function originalContractSelection(ref: DraftingOriginalContractRef | null): string {
  if (!ref) return ""
  return `${ref.kind}:${ref.id}:${ref.versionId}`
}

/** Options for the original-contract selector: project material versions plus saved specialty-subcontract drafts. */
export function originalContractOptions(materials: Array<{ id: string; title: string; versionId: string }>, drafts: ProjectResultView[]): Array<{ value: string; label: string; ref: DraftingOriginalContractRef }> {
  const options: Array<{ value: string; label: string; ref: DraftingOriginalContractRef }> = []
  for (const material of materials) {
    const ref: DraftingOriginalContractRef = { kind: "material", id: material.id, versionId: material.versionId, title: material.title }
    options.push({ value: originalContractSelection(ref), label: `材料：${material.title}（版本 ${material.versionId}）`, ref })
  }
  for (const draft of drafts) {
    if (draft.kind !== "specialty-subcontract") continue
    const value = readDraftValue(draft.value)
    const ref: DraftingOriginalContractRef = {
      kind: "result", id: draft.resultId, versionId: draft.versionId,
      title: value?.template.id === "specialty-subcontract-v1" ? "专业分包合同成果" : "专业分包合同成果",
      sha256: draft.sha256,
    }
    options.push({ value: originalContractSelection(ref), label: `专业分包合同成果（版本 ${draft.versionId.slice(0, 8)}）`, ref })
  }
  return options
}

export function parseOriginalContractSelection(value: string, options: Array<{ value: string; ref: DraftingOriginalContractRef }>): DraftingOriginalContractRef | null {
  if (!value) return null
  return options.find(option => option.value === value)?.ref ?? null
}

/** The component only ever offers reject / request-changes for a 待核对 draft. */
export function reviewDecisionOptions(validationStatus: string): Array<{ value: "rejected" | "changes_requested"; label: string }> {
  const options: Array<{ value: "rejected" | "changes_requested"; label: string }> = [
    { value: "changes_requested", label: "退回修改" },
    { value: "rejected", label: "驳回" },
  ]
  return options.filter(option => option.value !== "rejected" || validationStatus !== "valid")
}

export function readDraftValue(value: unknown): DraftingValueView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const draft = value as Partial<DraftingValueView>
  if (draft.schemaVersion !== 1 || (draft.kind !== "specialty-subcontract" && draft.kind !== "supplementary-agreement")) return null
  if (draft.status !== "partial" || !draft.template || typeof draft.template.id !== "string" || draft.template.status !== "待核对") return null
  if (!Array.isArray(draft.paragraphs) || !Array.isArray(draft.missing) || !Array.isArray(draft.fields)) return null
  if (!draft.input || typeof draft.input.versionId !== "string") return null
  return draft as DraftingValueView
}

export function draftResultLabel(draft: ProjectResultView): string {
  const value = readDraftValue(draft.value)
  if (!value) return "无法读取的文书草稿"
  return `${DRAFTING_KIND_LABELS[value.kind]}（${value.template.version}）`
}

export function draftMissingCount(draft: ProjectResultView): number {
  return readDraftValue(draft.value)?.missing.length ?? 0
}

/** True when the saved proposed input is newer than the draft's pinned input version. */
export function needsRegeneration(draft: ProjectResultView, form: DraftingForm): boolean {
  const value = readDraftValue(draft.value)
  if (!value) return false
  if (value.kind !== form.templateId.replace(/-v\d+$/, "")) return true
  return value.input.versionId !== form.versionId
}

export function validationLabel(status: string): string {
  return (DRAFTING_STATUS_LABELS as Record<string, string>)[status] ?? status
}

export function reviewLabel(decision: string | null | undefined): string {
  return DRAFTING_REVIEW_LABELS[decision ?? "pending"] ?? "待复核"
}

/** Operation id reuse for one unchanged submission signature (network-retry safe). */
export type DraftingOperation = { key: string; signature: string }
export function nextDraftingOperation(previous: DraftingOperation | null, signature: string, create: () => string): DraftingOperation {
  if (previous && previous.signature === signature) return previous
  return { key: create(), signature }
}

export function formSignature(form: DraftingForm, purpose: "save" | "generate" | "revise", extra = ""): string {
  return JSON.stringify({ purpose, templateId: form.templateId, values: sortedValues(form.values), originalContract: form.originalContract, inputId: form.inputId, versionId: form.versionId, extra })
}

/** The drafting host only mounts this workspace for the business tab; empty states name the absent resource. */
export function draftingEmptyState(kind: "inputs" | "drafts" | "materials"): string {
  if (kind === "inputs") return "暂无拟约定输入"
  if (kind === "drafts") return "暂无文书草稿"
  return "暂无可作为原合同的项目材料"
}

/** Tiny facade type for tests that exercise pure logic only. */
export type DraftingClientLike = Pick<ProjectDraftingClient, "listInputs" | "saveInput" | "generateDraft" | "reviseDraft">
export type DraftingDetailInput = DraftingInputDetailView
