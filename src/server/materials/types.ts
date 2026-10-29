export type MaterialFormat = "docx" | "pdf"

export type CoverageStatus = "available" | "partial" | "failed"
export type CoverageFindingCode =
  | "embedded_image" | "textbox" | "revision" | "merged_cell" | "header_footer" | "comment" | "note"
  | "content_control" | "unsupported_structure" | "external_link" | "ocr_unavailable" | "no_text"
  | "scanned_image" | "cid_font" | "unsupported_filter"
export type CoverageFinding = { code: CoverageFindingCode; location: string }
export type ParseCoverage = { status: CoverageStatus; findings: CoverageFinding[]; pageCount: number | null; textLength: number }

export type ParsedFragment = {
  kind: "paragraph" | "table"
  order: number
  page: number | null
  paragraph: number | null
  headingPath: string[]
  tableIndex: number | null
  row: number | null
  column: number | null
  text: string
}

export type ParsedMaterial = {
  format: MaterialFormat
  parser: string
  parserVersion: string
  coverage: ParseCoverage
  fragments: ParsedFragment[]
  text: string
}

export type MaterialSourceKind = "synthetic" | "authorized"

/** Registration is completed before any object is persisted. */
export type MaterialRegistration = {
  projectId: string
  title: string
  fileName: string | null
  sourceKind: MaterialSourceKind
  sourceReference: string
  processingAuthorized: true
  purpose: string
  retentionUntil: string
}

export type MaterialInput = {
  registration: MaterialRegistration
  bytes: Uint8Array
  contentType: string
}

export type MaterialRecord = {
  id: string
  projectId: string
  title: string
  fileName: string | null
  format: MaterialFormat
  sourceKind: MaterialSourceKind
  sourceReference: string
  processingAuthorized: boolean
  purpose: string
  retentionUntil: string
  status: "active" | "deleted"
  latestRevision: number
  latestVersionId: string
  createdBy: string
  createdAt: string
}

export type MaterialVersionRecord = {
  id: string
  projectId: string
  materialId: string
  revision: number
  sha256: string
  size: number
  contentType: string
  objectKey: string
  fileName: string | null
  createdAt: string
}

export type ParseSnapshotRecord = {
  id: string
  projectId: string
  materialId: string
  versionId: string
  revision: number
  parser: string
  parserVersion: string
  coverage: ParseCoverage
  createdAt: string
}

export type SourceFragmentRecord = {
  id: string
  projectId: string
  snapshotId: string
  kind: "paragraph" | "table"
  order: number
  page: number | null
  paragraph: number | null
  headingPath: string[]
  tableIndex: number | null
  row: number | null
  column: number | null
  text: string
}

export type MaterialSummary = {
  id: string
  title: string
  fileName: string | null
  format: MaterialFormat
  size: number
  sha256: string
  versionId: string
  createdAt: string
  snapshotId: string | null
  coverage: ParseCoverage | null
}

export type MaterialReadResult = {
  material: MaterialRecord
  version: MaterialVersionRecord
  bytes: Uint8Array
  contentType: string
  fileName: string | null
}

export type ParseSnapshotReadResult = {
  snapshot: ParseSnapshotRecord
  material: MaterialRecord
  version: MaterialVersionRecord
}

export type SourceReadResult = {
  snapshot: ParseSnapshotRecord
  fragment: SourceFragmentRecord
}

export type RegisterMaterialResult = {
  material: MaterialRecord
  version: MaterialVersionRecord
  snapshot: ParseSnapshotRecord
  coverage: ParseCoverage
  duplicate: boolean
}

export type ResidualObject = {
  id: string
  projectId: string
  objectKey: string
  reason: string
  attempts: number
  createdAt: string
  resolvedAt: string | null
}
