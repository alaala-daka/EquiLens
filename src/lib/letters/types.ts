/** 项目催款函（第八轮）：确定性渲染、显式版本引用、不自动外发。 */

export type LetterVersionRef = { resultId: string; versionId: string; sha256: string }

export type LetterPaymentSnapshot = {
  resultId: string
  versionId: string
  sha256: string
  netDueFen: string
  paidFen: string
  unpaidFen: string
  formula: string
}

export type LetterFactSnapshot = { factId: string; factVersionId: string; field: string; selectedValue?: string }

export type LetterEvidenceSnapshot = { resultId: string; versionId: string; sha256: string; status: "draft" | "incomplete" }

export type CollectionLetterDraft = {
  cutoff: string
  contractTitle: string
  sender: string
  recipient: string
  demand: string
  plannedDate: string
  method: string
  address: string
  payment: LetterVersionRef
  factVersionIds: string[]
  evidence?: LetterVersionRef
}

export type CollectionLetterValue = {
  schemaVersion: 1
  templateVersion: "collection-letter-v1"
  cutoff: string
  contractTitle: string
  sender: string
  recipient: string
  demand: string
  plannedDate: string
  method: string
  address: string
  payment: LetterPaymentSnapshot | null
  facts: LetterFactSnapshot[]
  evidence?: LetterEvidenceSnapshot
  paragraphs: string[]
  missing: string[]
  status: "draft" | "ready"
}

export type SaveCollectionLetter = {
  operationId: string
  reason: string
  baseVersionId: string
  value: CollectionLetterDraft
}
