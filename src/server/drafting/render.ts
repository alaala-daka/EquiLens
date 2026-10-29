import {
  MISSING_PREFIX, TEMPLATE_UNREVIEWED_WARNING, conditionActive, missingFields, sectionTitle,
  type DraftingTemplate,
} from "../templates/catalog"

/**
 * C5 deterministic drafting renderer (plan §4.3/§5 C5).
 *
 * Pure function of the code-versioned template, the saved proposed values and
 * the pinned original-contract reference. It never reads the database, calls a
 * model or invents values: every variable comes from the template's fixed
 * clauses or from the user's proposed input, and anything absent renders as
 * `【待补充：标签】`. The same inputs always produce byte-identical paragraphs,
 * which is what lets the result validator detect browser-forged paragraphs.
 */
export type DraftingOriginalContractRef = {
  kind: "material" | "result"
  id: string
  versionId: string
  title: string
  sha256?: string
}

export type DraftingInputMeta = {
  inputId: string
  versionId: string
  version: number
  sha256: string
}

export type DraftingMissingField = { fieldId: string; label: string; section: string; reason: "required" | "conditional" }

export type DraftingRenderInput = {
  template: DraftingTemplate
  values: Record<string, string>
  originalContract: DraftingOriginalContractRef | null
  input: DraftingInputMeta
}

export type DraftingRenderResult = {
  paragraphs: string[]
  missing: DraftingMissingField[]
}

export function missingMarker(label: string): string {
  return `${MISSING_PREFIX}${label}】`
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g

function fieldLabel(template: DraftingTemplate, fieldId: string): string {
  const field = template.fields.find(item => item.id === fieldId)
  if (field) return field.label
  if (fieldId === "originalContract.title") return "原合同标题"
  if (fieldId === "originalContract.versionId") return "原合同版本"
  return fieldId
}

/** Insert only the saved proposed values / pinned original-contract reference; everything else is a missing marker. */
export function fillClause(template: DraftingTemplate, text: string, values: Record<string, string>, originalContract: DraftingOriginalContractRef | null): string {
  const variables: Record<string, string> = {}
  for (const field of template.fields) {
    const value = (values[field.id] ?? "").trim()
    if (value) variables[field.id] = value
  }
  if (originalContract) {
    variables["originalContract.title"] = originalContract.title.trim()
    variables["originalContract.versionId"] = originalContract.versionId
  }
  return text.replace(PLACEHOLDER, (_match, fieldId: string) => variables[fieldId] ?? missingMarker(fieldLabel(template, fieldId)))
}

export function renderDraft(input: DraftingRenderInput): DraftingRenderResult {
  const { template, values, originalContract, input: meta } = input
  const paragraphs: string[] = []
  paragraphs.push(`${template.label}（草稿）`)
  paragraphs.push(`模板：${template.id} ${template.version}；模板状态：待核对，未完成领域核对，本文件不能作为完整复核成果。`)
  paragraphs.push(`拟约定输入：第 ${meta.version} 版；版本标识：${meta.versionId}；输入摘要：${meta.sha256}。`)
  if (originalContract) paragraphs.push(`原合同：${originalContract.title}；原合同版本：${originalContract.versionId}。`)
  for (const [sectionIndex, section] of template.sections.entries()) {
    paragraphs.push(`${sectionIndex + 1}. ${section.title}`)
    let clauseNumber = 0
    for (const clause of section.clauses) {
      if (clause.when && !conditionActive(template, clause.when, values)) continue
      clauseNumber++
      paragraphs.push(`${sectionIndex + 1}.${clauseNumber} ${fillClause(template, clause.text, values, originalContract)}`)
    }
  }
  for (const field of template.fields) {
    if (field.required === "always" || conditionActive(template, field.required.when, values)) continue
    if (!(values[field.id] ?? "").trim()) continue
    // A conditionally-required field without an active requirement is not part
    // of the rendered contract; keep only required/conditional clauses above.
  }
  paragraphs.push(`提示：${TEMPLATE_UNREVIEWED_WARNING}`)
  const missing = missingFields(template, values).map(item => ({ ...item }))
  return { paragraphs, missing }
}

/** Labels used by the client form and the export template. */
export function fieldSectionLabel(template: DraftingTemplate, fieldId: string): string {
  const field = template.fields.find(item => item.id === fieldId)
  return field ? sectionTitle(template, field.section) : ""
}
