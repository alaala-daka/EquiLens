import { createHash } from "node:crypto"
import { canonicalJson } from "../results/validation"
import {
  draftingFieldValueError, type DraftingKind, type DraftingTemplate,
} from "../templates/catalog"
import type { DraftingOriginalContractRef } from "./render"

/**
 * Immutable proposed-input payload for one drafting input version (spec 01 §8.2.4).
 *
 * Only template-declared field ids are accepted; forbidden/extra keys, non-string
 * values, unknown fields, invalid amounts/dates/choices and over-length values
 * are rejected before anything is persisted. An empty value means "not
 * provided" (it renders as `【待补充：标签】`), never a fabricated default.
 */
export type DraftingInputPayload = {
  schemaVersion: 1
  templateId: string
  kind: DraftingKind
  /** Template order; only provided (non-empty) values are stored. */
  fields: Array<{ fieldId: string; value: string }>
  originalContract: DraftingOriginalContractRef | null
}

export type NormalizedDraftingFields = { payload: DraftingInputPayload; issues: string[] }

const MAX_FIELDS = 64

export function normalizeDraftingInput(
  template: DraftingTemplate,
  rawFields: unknown,
  originalContract: DraftingOriginalContractRef | null,
): NormalizedDraftingFields {
  const issues: string[] = []
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    return { payload: { schemaVersion: 1, templateId: template.id, kind: template.kind, fields: [], originalContract }, issues: ["拟约定输入字段无效。"] }
  }
  const input = rawFields as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length > MAX_FIELDS) issues.push("拟约定输入字段过多。")
  const byId = new Map(template.fields.map(field => [field.id, field]))
  const fields: Array<{ fieldId: string; value: string }> = []
  for (const [fieldId, rawValue] of Object.entries(input)) {
    const field = byId.get(fieldId)
    if (!field) { issues.push("拟约定输入包含模板未登记的字段。"); continue }
    if (typeof rawValue !== "string") { issues.push(`「${field.label}」必须是文本值。`); continue }
    const value = rawValue.trim()
    if (!value) continue
    const failure = draftingFieldValueError(field, value)
    if (failure) { issues.push(`「${field.label}」${failure}`); continue }
    fields.push({ fieldId, value })
  }
  // Canonical template order so equal inputs produce the same digest and render.
  fields.sort((left, right) => template.fields.findIndex(field => field.id === left.fieldId) - template.fields.findIndex(field => field.id === right.fieldId))
  return { payload: { schemaVersion: 1, templateId: template.id, kind: template.kind, fields, originalContract }, issues }
}

export function valuesFromPayload(payload: DraftingInputPayload): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of payload.fields) values[field.fieldId] = field.value
  return values
}

export function payloadSha256(payload: DraftingInputPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex")
}

export function payloadRequestHash(payload: DraftingInputPayload, baseVersionId: string): string {
  return createHash("sha256").update(canonicalJson({ payload, baseVersionId })).digest("hex")
}
