import { createHash } from "node:crypto"
import {
  DRAFTING_RENDER_VERSION, TEMPLATE_UNREVIEWED_CODE, TEMPLATE_UNREVIEWED_WARNING,
  draftingFieldValueError, draftingTemplateForKind, missingFields, sectionTitle,
  type DraftingKind, type DraftingTemplate,
} from "../templates/catalog"
import { canonicalJson, type ResultValidator } from "../results/validation"
import { payloadSha256, type DraftingInputPayload } from "./payload"
import { renderDraft, type DraftingOriginalContractRef } from "./render"
import { isDraftingKind, type DraftingValue } from "./value"

/**
 * C5 draft validators (spec 01 §8.2.4, plan §4.3/§5 C5).
 *
 * The validator never trusts the stored value: it re-checks the code template
 * id/version/sha/status, the proposed-field allowlist and types (decimal amount
 * strings, dates, fixed choices), the pinned input-version digest, the
 * original-contract pin, the recomputed missing list and — decisively — it
 * re-renders the deterministic template from the embedded field values and
 * requires the paragraphs to match exactly. Browser/post-hoc paragraph edits
 * are therefore invalid.
 *
 * A "待核对" template can only ever produce a partial draft with the
 * TEMPLATE_UNREVIEWED warning; this round cannot produce a `valid` C5 result,
 * so it can never be approved as a complete review result.
 */
type Issue = { code: string; message: string; ref?: string }

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const digestPattern = /^[a-f0-9]{64}$/

export type DraftingInspection = { value: DraftingValue | null; issues: Issue[] }

function inspectFields(template: DraftingTemplate, raw: unknown, issues: Issue[]): Record<string, string> {
  const values: Record<string, string> = {}
  if (!Array.isArray(raw)) { issues.push({ code: "INVALID_STRUCTURE", message: "草稿缺少拟约定字段。" }); return values }
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const field = object(entry)
    const ref = `fields[${index}]`
    if (!field || typeof field.fieldId !== "string" || !text(field.fieldId)) {
      issues.push({ code: "INVALID_STRUCTURE", message: "草稿字段结构无效。", ref })
      continue
    }
    const definition = template.fields.find(item => item.id === field.fieldId)
    if (!definition) { issues.push({ code: "INVALID_FIELDS", message: "草稿包含模板未登记的字段。", ref }); continue }
    if (seen.has(field.fieldId)) { issues.push({ code: "INVALID_FIELDS", message: "草稿字段重复。", ref }); continue }
    seen.add(field.fieldId)
    const value = typeof field.value === "string" ? field.value.trim() : ""
    if (!value || draftingFieldValueError(definition, value)) {
      issues.push({ code: "INVALID_FIELDS", message: "草稿字段值不符合模板类型或长度要求。", ref })
      continue
    }
    if (text(field.label) !== definition.label || text(field.section) !== sectionTitle(template, definition.section) ||
      field.kind !== definition.kind || field.source !== definition.source) {
      issues.push({ code: "INVALID_FIELDS", message: "草稿字段元数据与模板不一致。", ref })
      continue
    }
    values[field.fieldId] = value
  }
  return values
}

function inspectOriginalContract(template: DraftingTemplate, raw: unknown, issues: Issue[]): DraftingOriginalContractRef | null {
  const rule = template.originalContract
  if (!rule) {
    if (raw !== null && raw !== undefined) issues.push({ code: "INVALID_STRUCTURE", message: "该文书类型不应包含原合同引用。" })
    return null
  }
  const record = object(raw)
  if (!record) { issues.push({ code: "INVALID_ORIGINAL_CONTRACT", message: "补充协议缺少原合同版本引用。" }); return null }
  if (record.kind !== "material" && record.kind !== "result") {
    issues.push({ code: "INVALID_ORIGINAL_CONTRACT", message: "原合同引用类型无效。" })
    return null
  }
  if (!rule.allowed.some(item => item.kind === record.kind)) {
    issues.push({ code: "INVALID_ORIGINAL_CONTRACT", message: "原合同引用类型不被该模板允许。" })
    return null
  }
  const id = text(record.id), versionId = text(record.versionId), title = text(record.title)
  if (!id || !versionId || !title || id.length > 128 || versionId.length > 128 || title.length > 300) {
    issues.push({ code: "INVALID_ORIGINAL_CONTRACT", message: "原合同引用缺少必要标识。" })
    return null
  }
  const sha256 = record.sha256 === undefined ? undefined : text(record.sha256)
  if (sha256 !== undefined && !digestPattern.test(sha256)) {
    issues.push({ code: "INVALID_ORIGINAL_CONTRACT", message: "原合同引用摘要无效。" })
    return null
  }
  return { kind: record.kind, id, versionId, title, ...(sha256 ? { sha256 } : {}) }
}

/** Structural + deterministic re-render inspection shared by both C5 validators and the export guard. */
export function inspectDraftingValue(value: unknown, expected?: DraftingKind): DraftingInspection {
  const issues: Issue[] = []
  const root = object(value)
  if (!root) return { value: null, issues: [{ code: "INVALID_STRUCTURE", message: "文书草稿不是有效对象。" }] }
  if (root.schemaVersion !== 1) issues.push({ code: "INVALID_STRUCTURE", message: "文书草稿版本不受支持。" })
  if (!isDraftingKind(root.kind)) issues.push({ code: "INVALID_STRUCTURE", message: "文书草稿类型无效。" })
  if (expected && root.kind !== expected) issues.push({ code: "INVALID_STRUCTURE", message: "文书草稿类型与成果类型不一致。" })
  const kind = isDraftingKind(root.kind) ? root.kind : expected
  const template = kind ? draftingTemplateForKind(kind) : null
  if (!template) return { value: null, issues: [...issues, { code: "INVALID_TEMPLATE", message: "找不到对应的文书模板。" }] }

  const templateRecord = object(root.template)
  if (!templateRecord) issues.push({ code: "INVALID_TEMPLATE", message: "文书草稿缺少模板信息。" })
  else {
    if (text(templateRecord.id) !== template.id) issues.push({ code: "INVALID_TEMPLATE", message: "文书草稿模板标识与类型不一致。" })
    if (text(templateRecord.version) !== template.version) issues.push({ code: "INVALID_TEMPLATE", message: "文书草稿模板版本不受支持。" })
    if (text(templateRecord.sha256) !== template.sha256) issues.push({ code: "INVALID_TEMPLATE", message: "文书草稿模板摘要与固定模板不一致。" })
    if (text(templateRecord.status) !== template.status) issues.push({ code: "INVALID_TEMPLATE", message: "文书草稿模板状态与固定模板不一致。" })
  }
  if (root.status !== "partial") issues.push({ code: "INVALID_STATUS", message: "待核对模板只能生成部分完成的草稿。" })
  if (text(root.renderVersion) !== DRAFTING_RENDER_VERSION) issues.push({ code: "INVALID_STRUCTURE", message: "文书草稿渲染版本不受支持。" })

  const warnings = Array.isArray(root.warnings) ? root.warnings as unknown[] : null
  const unreviewed = warnings?.some(warning => object(warning)?.code === TEMPLATE_UNREVIEWED_CODE)
  if (!warnings) issues.push({ code: "INVALID_STRUCTURE", message: "文书草稿缺少警告记录。" })
  else if (!unreviewed) issues.push({ code: "INVALID_TEMPLATE", message: "待核对模板的草稿必须带未核对警告。" })

  const input = object(root.input)
  let validInput = false
  if (!input) issues.push({ code: "INVALID_INPUT_VERSION", message: "文书草稿缺少拟约定输入版本信息。" })
  else {
    if (!text(input.inputId) || text(input.inputId).length > 128) issues.push({ code: "INVALID_INPUT_VERSION", message: "拟约定输入标识无效。" })
    if (!text(input.versionId) || text(input.versionId).length > 128) issues.push({ code: "INVALID_INPUT_VERSION", message: "拟约定输入版本标识无效。" })
    if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) issues.push({ code: "INVALID_INPUT_VERSION", message: "拟约定输入版本号无效。" })
    if (typeof input.sha256 !== "string" || !digestPattern.test(input.sha256)) issues.push({ code: "INVALID_INPUT_VERSION", message: "拟约定输入摘要无效。" })
    validInput = !issues.some(issue => issue.code === "INVALID_INPUT_VERSION")
  }

  const values = inspectFields(template, root.fields, issues)
  const originalContract = inspectOriginalContract(template, root.originalContract, issues)

  if (validInput && input) {
    const payload: DraftingInputPayload = {
      schemaVersion: 1, templateId: template.id, kind: template.kind,
      fields: template.fields.filter(field => values[field.id] !== undefined).map(field => ({ fieldId: field.id, value: values[field.id] })),
      originalContract,
    }
    if (payloadSha256(payload) !== text(input.sha256)) issues.push({ code: "INVALID_INPUT_VERSION", message: "拟约定字段与固定输入版本摘要不一致。" })
  }

  const expectedMissing = missingFields(template, values)
  const rawMissing = Array.isArray(root.missing) ? root.missing as unknown[] : null
  if (!rawMissing) issues.push({ code: "INVALID_MISSING", message: "文书草稿缺少缺失字段清单。" })
  else {
    const actual = rawMissing.map(entry => {
      const record = object(entry)
      return record ? { fieldId: text(record.fieldId), label: text(record.label), section: text(record.section), reason: text(record.reason) } : null
    })
    const expected = expectedMissing.map(entry => ({ fieldId: entry.fieldId, label: entry.label, section: entry.section, reason: entry.reason }))
    const consistent = actual.length === expected.length && actual.every((entry, index) => Boolean(entry) &&
      entry!.fieldId === expected[index].fieldId && entry!.label === expected[index].label &&
      entry!.section === expected[index].section && entry!.reason === expected[index].reason)
    if (!consistent) issues.push({ code: "INVALID_MISSING", message: "缺失字段清单与拟约定输入不一致。" })
  }

  const paragraphs = Array.isArray(root.paragraphs) ? root.paragraphs as unknown[] : null
  if (!paragraphs) issues.push({ code: "INVALID_RENDER", message: "文书草稿缺少渲染正文。" })
  else if (paragraphs.length < 2 || paragraphs.length > 500 ||
    paragraphs.some(paragraph => typeof paragraph !== "string" || !paragraph.trim() || paragraph.length > 4000)) {
    issues.push({ code: "INVALID_RENDER", message: "文书草稿正文结构无效。" })
  } else if (validInput && input) {
    const rendered = renderDraft({
      template, values, originalContract,
      input: { inputId: text(input.inputId), versionId: text(input.versionId), version: Number(input.version), sha256: text(input.sha256) },
    })
    if (canonicalJson(rendered.paragraphs) !== canonicalJson(paragraphs)) {
      issues.push({ code: "INVALID_RENDER", message: "文书正文与固定模板确定性填充结果不一致。" })
    }
  }

  if (issues.length) return { value: null, issues }
  const record: DraftingValue = {
    schemaVersion: 1,
    kind: template.kind,
    status: "partial",
    template: { id: template.id, version: template.version, sha256: template.sha256, status: "待核对" },
    input: { inputId: text(input!.inputId), versionId: text(input!.versionId), version: Number(input!.version), sha256: text(input!.sha256) },
    fields: template.fields.filter(field => values[field.id] !== undefined).map(field => ({
      fieldId: field.id, label: field.label, section: sectionTitle(template, field.section), kind: field.kind, source: field.source, value: values[field.id],
    })),
    originalContract,
    missing: expectedMissing.map(item => ({ ...item })),
    paragraphs: [...(paragraphs as string[])],
    warnings: [{ code: TEMPLATE_UNREVIEWED_CODE, message: TEMPLATE_UNREVIEWED_WARNING }],
    renderVersion: DRAFTING_RENDER_VERSION,
  }
  return { value: record, issues: [] }
}

export function createDraftingValidator(expected: DraftingKind): ResultValidator {
  return async value => {
    const inspected = inspectDraftingValue(value, expected)
    // A fixed "待核对" template can only produce partial drafts this round.
    return { status: inspected.value ? "partial" : "invalid", issues: inspected.issues }
  }
}

export const specialtySubcontractValidator = createDraftingValidator("specialty-subcontract")
export const supplementaryAgreementValidator = createDraftingValidator("supplementary-agreement")

/** Test seam: recompute the proposed-input digest with the same canonical algorithm. */
export function draftingPayloadDigest(payload: DraftingInputPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex")
}
