import { createHash } from "node:crypto"
import type { DocumentAnalysis } from "../../lib/document-agent/types"
import type { Paragraph } from "../../../tools/contract-review/src/types"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { extractionSchema } from "./schema"
import { calculateDocumentAmounts, validateExtraction } from "./validation"

export const analysisSha = (analysis: DocumentAnalysis) => createHash("sha256").update(JSON.stringify(analysis)).digest("hex")

/**
 * 人工修订只接受 extraction 的结构化修改；机器整理/审计记录保持不变，
 * 重新校验引文并按新金额重算，避免人工编辑绕过来源校验。
 */
export function applyHumanExtraction(machine: DocumentAnalysis, extractionInput: unknown, paragraphs: Paragraph[], cutoff: string): DocumentAnalysis {
  if (machine.task === "collection-letter") throw new ReviewError("REVIEW_INPUT_INVALID")
  const extraction = extractionSchema.parse(extractionInput)
  const rejected = validateExtraction(extraction, paragraphs, cutoff)
  if (rejected.length) throw new ReviewError("REVIEW_INPUT_INVALID")
  const analysis = structuredClone(machine)
  analysis.extraction = extraction
  analysis.rejected = []
  if (machine.task === "payment-reconciliation") {
    const calculated = calculateDocumentAmounts(extraction, cutoff, extraction.coverage === "完整" && !extraction.gaps.length)
    analysis.calculation = calculated.calculation
    analysis.calculationNotes = calculated.calculationNotes
  } else {
    analysis.calculation = null
    analysis.calculationNotes = []
  }
  return analysis
}

export type HumanRevisionPayload = {
  versionId: string
  versionNumber: number
  baseVersionId: string
  analysis: DocumentAnalysis
  changeReason: string
  createdBy: string
  createdAt: string
  sha256: string
}
