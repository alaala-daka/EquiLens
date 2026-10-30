import type { VerificationFieldKey } from "../../lib/business/verification-fields"

/**
 * Frozen field-reading seam between C4-OCR (writer) and C4-VERIFY (consumer).
 *
 * The field vocabulary, labels and normalization live in
 * src/lib/business/verification-fields.ts; this module only fixes the shape that
 * both packages share. Only the current (non-superseded) value of each
 * (material version, subject, field) is returned. Consumers must never read the
 * database directly and must not invent a parallel field store.
 */
export type VerificationFieldOrigin = "ocr" | "manual" | "material_text"

export type VerificationFieldValue = {
  materialId: string
  versionId: string
  /** "enterprise" for subject-level certificates, or an explicit per-person key. */
  subjectKey: string
  fieldKey: VerificationFieldKey
  label: string
  /** Raw value as recognized or entered (never overwritten by a correction). */
  valueText: string
  normalizedValue: string
  origin: VerificationFieldOrigin
  sourceSnapshotId: string | null
  sourceFragmentId: string | null
  ocrRunId: string | null
  confidence: number | null
  revision: number
  updatedAt: string
}

export type FieldSource = {
  /** Current values for the given material versions in one project; empty when none. */
  values(projectId: string, materialVersionIds: readonly string[]): Promise<VerificationFieldValue[]>
}
