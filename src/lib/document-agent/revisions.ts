import type { DocumentAnalysis } from "./types"

export type DocumentReviewDecision = "通过" | "驳回" | "退回修改"

export type DocumentReview = {
  reviewId: string
  versionId: string
  decision: DocumentReviewDecision
  reviewer: string
  note: string
  createdAt: string
}

export type DocumentRevisionSummary = {
  versionId: string
  versionNumber: number
  baseVersionId?: string
  isMachine: boolean
  createdAt: string
  createdBy: string
  changeReason?: string
  sha256: string
  review: DocumentReview | null
}

export type DocumentRevision = DocumentRevisionSummary & { analysis: DocumentAnalysis }
