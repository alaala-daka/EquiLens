import { isVerificationFieldKey } from "../../../lib/business/verification-fields"
import {
  defaultComparisonForm,
  defaultExternalRecordForm,
  defaultExtractionForm,
  defaultFieldForm,
  type ComparisonForm,
  type ExternalRecordForm,
  type ExtractionForm,
  type FieldForm,
} from "./verification-state"

/**
 * Project-scoped preparation input for the bid-verification workspace.
 *
 * Round five freezes the HTTP surface: extraction/comparison conditions and the
 * short field/record forms have no server "preparation input" endpoint, so a
 * deliberately saved workspace draft is kept in browser storage per project.
 * Saving a draft never submits a task, registers a field or appends a record.
 */
export type VerificationFormDraft = {
  version: 1
  extraction: ExtractionForm
  comparison: ComparisonForm
  field: FieldForm
  externalRecord: ExternalRecordForm
  fieldMaterialId: string
}

export function defaultVerificationFormDraft(): VerificationFormDraft {
  return {
    version: 1,
    extraction: defaultExtractionForm(),
    comparison: defaultComparisonForm(),
    field: defaultFieldForm(),
    externalRecord: defaultExternalRecordForm(),
    fieldMaterialId: "",
  }
}

export type VerificationDraftStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function verificationDraftKey(projectId: string): string {
  return `equilens.verification-draft.${projectId}`
}

export function serializeVerificationDraft(draft: VerificationFormDraft): string {
  return JSON.stringify(draft)
}

function stringList(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 128).slice(0, max)
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" && value.length <= max ? value : ""
}

function extraction(value: unknown): ExtractionForm {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return { materialIds: stringList(record.materialIds, 10), asOf: text(record.asOf, 10), consent: record.consent === true }
}

function comparison(value: unknown): ComparisonForm {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    materialIds: stringList(record.materialIds, 10),
    requirementSetResultId: text(record.requirementSetResultId, 128),
    asOf: text(record.asOf, 10),
    recordIds: stringList(record.recordIds, 200),
  }
}

function field(value: unknown): FieldForm {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    fieldKey: isVerificationFieldKey(record.fieldKey) ? record.fieldKey : defaultFieldForm().fieldKey,
    valueText: text(record.valueText, 2000),
    subjectKey: text(record.subjectKey, 64) || "enterprise",
    sourceFragmentId: text(record.sourceFragmentId, 64),
    reason: text(record.reason, 500),
  }
}

const conclusions = new Set(["matched", "conflict", "not_found", "query_failed", "pending"])
function externalRecord(value: unknown): ExternalRecordForm {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    requirementId: text(record.requirementId, 128),
    subject: text(record.subject, 200),
    certificateNo: text(record.certificateNo, 128),
    source: text(record.source, 500),
    queriedAt: text(record.queriedAt, 32),
    queryConditions: text(record.queryConditions, 500),
    conclusion: typeof record.conclusion === "string" && conclusions.has(record.conclusion) ? record.conclusion as ExternalRecordForm["conclusion"] : "",
    proofMaterialVersionId: text(record.proofMaterialVersionId, 128),
  }
}

/** Corrupt, foreign or oversized drafts are ignored instead of breaking the forms. */
export function parseVerificationDraft(raw: string | null): VerificationFormDraft | null {
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  return {
    version: 1,
    extraction: extraction(record.extraction),
    comparison: comparison(record.comparison),
    field: field(record.field),
    externalRecord: externalRecord(record.externalRecord),
    fieldMaterialId: text(record.fieldMaterialId, 128),
  }
}

export function readVerificationDraft(storage: VerificationDraftStorage | null, projectId: string): VerificationFormDraft | null {
  if (!storage) return null
  try { return parseVerificationDraft(storage.getItem(verificationDraftKey(projectId))) } catch { return null }
}

/** Resolves true only when the draft was actually persisted. */
export function writeVerificationDraft(storage: VerificationDraftStorage | null, projectId: string, draft: VerificationFormDraft): boolean {
  if (!storage) return false
  storage.setItem(verificationDraftKey(projectId), serializeVerificationDraft(draft))
  return true
}

export function clearVerificationDraft(storage: VerificationDraftStorage | null, projectId: string): void {
  if (!storage) return
  try { storage.removeItem(verificationDraftKey(projectId)) } catch { /* dropping a draft must not trap navigation */ }
}

/** Per-tab browser storage; a blocked storage simply means the draft cannot be saved. */
export function browserVerificationDraftStorage(): VerificationDraftStorage | null {
  if (typeof window === "undefined") return null
  try { return window.sessionStorage } catch { return null }
}

export function isVerificationDraftDirty(draft: VerificationFormDraft): boolean {
  return draft.extraction.materialIds.length > 0 || draft.extraction.asOf !== "" || draft.extraction.consent ||
    draft.comparison.materialIds.length > 0 || draft.comparison.requirementSetResultId !== "" ||
    draft.comparison.asOf !== "" || draft.comparison.recordIds.length > 0 ||
    draft.field.valueText !== "" || draft.field.sourceFragmentId !== "" || draft.field.reason !== "" || draft.fieldMaterialId !== "" ||
    draft.externalRecord.requirementId !== "" || draft.externalRecord.subject !== "" || draft.externalRecord.certificateNo !== "" ||
    draft.externalRecord.source !== "" || draft.externalRecord.queriedAt !== "" ||
    draft.externalRecord.queryConditions !== "" || draft.externalRecord.conclusion !== "" ||
    draft.externalRecord.proofMaterialVersionId !== ""
}
