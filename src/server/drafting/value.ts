import {
  DRAFTING_RENDER_VERSION, TEMPLATE_UNREVIEWED_CODE, TEMPLATE_UNREVIEWED_WARNING,
  sectionTitle, type DraftingKind, type DraftingFieldKind, type DraftingFieldSource, type DraftingTemplate,
} from "../templates/catalog"
import type { DraftingInputPayload } from "./payload"
import type { DraftingMissingField, DraftingOriginalContractRef, DraftingRenderResult } from "./render"

/**
 * C5 drafting result value (spec 01 §8.2.4).
 *
 * The value embeds everything needed to revalidate it without the database:
 * code template id/version/sha + status, the pinned proposed-input version and
 * digest, the exact proposed field values, the original-contract pin, the
 * missing-field list, the deterministically rendered paragraphs and the
 * unsigned-template warning. The result validator re-renders from this value
 * and rejects any divergence — browser/post-hoc editing cannot forge a draft.
 */
export type DraftingValueField = {
  fieldId: string
  label: string
  section: string
  kind: DraftingFieldKind
  source: DraftingFieldSource
  value: string
}

export type DraftingValue = {
  schemaVersion: 1
  kind: DraftingKind
  /** A "待核对" template can only ever produce a partial draft this round. */
  status: "partial"
  template: { id: string; version: string; sha256: string; status: "待核对" }
  input: { inputId: string; versionId: string; version: number; sha256: string }
  fields: DraftingValueField[]
  originalContract: DraftingOriginalContractRef | null
  missing: DraftingMissingField[]
  paragraphs: string[]
  warnings: Array<{ code: string; message: string }>
  renderVersion: string
}

export type DraftingInputMeta = Omit<DraftingValue["input"], "sha256"> & { sha256: string }

export function buildDraftingValue(input: {
  template: DraftingTemplate
  payload: DraftingInputPayload
  input: DraftingInputMeta
  render: DraftingRenderResult
}): DraftingValue {
  const { template, payload, input: meta, render } = input
  const values = new Map(payload.fields.map(field => [field.fieldId, field.value]))
  const fields: DraftingValueField[] = template.fields
    .filter(field => values.has(field.id))
    .map(field => ({
      fieldId: field.id,
      label: field.label,
      section: sectionTitle(template, field.section),
      kind: field.kind,
      source: field.source,
      value: String(values.get(field.id)),
    }))
  return {
    schemaVersion: 1,
    kind: template.kind,
    status: "partial",
    template: { id: template.id, version: template.version, sha256: template.sha256, status: template.status },
    input: { inputId: meta.inputId, versionId: meta.versionId, version: meta.version, sha256: meta.sha256 },
    fields,
    originalContract: payload.originalContract ? { ...payload.originalContract } : null,
    missing: render.missing.map(item => ({ ...item })),
    paragraphs: [...render.paragraphs],
    warnings: [{ code: TEMPLATE_UNREVIEWED_CODE, message: TEMPLATE_UNREVIEWED_WARNING }],
    renderVersion: DRAFTING_RENDER_VERSION,
  }
}

export function isDraftingKind(value: unknown): value is DraftingKind {
  return value === "specialty-subcontract" || value === "supplementary-agreement"
}
