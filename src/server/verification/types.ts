import { createHash } from "node:crypto"
import { canonicalJson } from "../results/validation"

/**
 * Server-side C4 verification primitives: controlled failure codes and the
 * canonical digest helpers shared by the record repository, the result service
 * and the executors.
 *
 * Failure codes are product-facing, fixed strings. Executors map them to the
 * task's terminal error code; HTTP services map their errors through the shared
 * `BusinessError` contract so SQL, credentials and material text never leak.
 */
export type VerificationFailureCode =
  | "INVALID_SUBMISSION"
  | "INVALID_SOURCE"
  | "RETENTION_EXPIRED"
  | "SERVICE_UNAVAILABLE"
  | "REQUIREMENT_SET_NOT_READY"
  | "REQUIREMENT_SET_INVALID"
  | "EXTERNAL_RECORD_INVALID"
  | "EXTRACTOR_FAILED"
  | "NO_REQUIREMENTS"
  | "BUDGET_EXHAUSTED"
  | "RESULT_INVALID"
  | "RESULT_MISMATCH"
  | "RESULT_SAVE_FAILED"

export const verificationFailureMessages: Record<VerificationFailureCode, string> = {
  INVALID_SUBMISSION: "任务输入清单无效，不能执行核验。",
  INVALID_SOURCE: "所选材料版本、解析快照、要求集或外部记录不可用，未写入成果。",
  RETENTION_EXPIRED: "项目或材料已超过保留期限，不能执行核验。",
  SERVICE_UNAVAILABLE: "材料或成果服务暂时不可用，请稍后重试。",
  REQUIREMENT_SET_NOT_READY: "要求集尚未完成人工确认，不能用于比较。",
  REQUIREMENT_SET_INVALID: "要求集结构或引用无效，不能用于比较。",
  EXTERNAL_RECORD_INVALID: "外部核验记录无效或与所选版本不符。",
  EXTRACTOR_FAILED: "要求候选提取未完成，未保存演示要求。",
  NO_REQUIREMENTS: "未取得可保存的要求候选，任务已失败。",
  BUDGET_EXHAUSTED: "本次任务已达到模型调用或费用预算上限。",
  RESULT_INVALID: "机器成果未通过服务端校验，任务已停止；原始结果已保留，不能复核或导出。",
  RESULT_MISMATCH: "机器输出与本任务输入不一致，任务已停止，未保存成果。",
  RESULT_SAVE_FAILED: "机器成果保存失败，任务已停止。",
}

export class VerificationError extends Error {
  constructor(readonly code: VerificationFailureCode) {
    super(verificationFailureMessages[code])
    this.name = "VerificationError"
  }
}

export function isVerificationError(failure: unknown): failure is VerificationError {
  return failure instanceof VerificationError
}

/** Task errors keep their safe code; they only describe a refused execution. */
export function taskFailureCode(failure: unknown): string | null {
  const code = failure && typeof failure === "object" && "code" in failure ? String((failure as { code?: unknown }).code ?? "") : ""
  return code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null
}

export const REQUIREMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** The immutable evidence fields an external verification record digest covers. */
export type RecordDigestInput = {
  requirementSetVersionId: string
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: string
  proofMaterialVersionId: string
}

/**
 * Canonical content of an external verification record. The digest pins exactly
 * the evidence fields a comparison task embeds, so re-reading a record can prove
 * it is the same record the manifest referenced and a later append cannot
 * silently change an already saved comparison.
 */
export function recordDigestContent(record: RecordDigestInput): string {
  return canonicalJson({
    requirementSetVersionId: record.requirementSetVersionId,
    requirementId: record.requirementId,
    subject: record.subject,
    certificateNo: record.certificateNo,
    source: record.source,
    queriedAt: record.queriedAt,
    queryConditions: record.queryConditions,
    conclusion: record.conclusion,
    proofMaterialVersionId: record.proofMaterialVersionId,
  })
}

export function recordSha256(record: RecordDigestInput): string {
  return createHash("sha256").update(recordDigestContent(record)).digest("hex")
}

/** Locale-independent code-unit comparison for canonical, platform-stable digests. */
export function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Digest of the field values a comparison result embedded, for the stale hint. */
export function evidenceDigest(values: ReadonlyArray<{
  fieldKey: string
  subjectKey: string
  valueText: string
  origin: string
  confidence: number | null
  materialVersionId: string
}>): string {
  const sorted = [...values]
    .map(value => ({
      fieldKey: value.fieldKey,
      subjectKey: value.subjectKey,
      valueText: value.valueText,
      origin: value.origin,
      confidence: value.confidence,
      materialVersionId: value.materialVersionId,
    }))
    .sort((left, right) =>
      codeUnitCompare(
        `${left.materialVersionId}\u0000${left.subjectKey}\u0000${left.fieldKey}\u0000${left.valueText}\u0000${left.origin}\u0000${left.confidence ?? ""}`,
        `${right.materialVersionId}\u0000${right.subjectKey}\u0000${right.fieldKey}\u0000${right.valueText}\u0000${right.origin}\u0000${right.confidence ?? ""}`,
      ))
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex")
}

/** Digest of the pinned external records embedded in a comparison result. */
export function recordListDigest(records: ReadonlyArray<{ recordId: string; sha256: string }>): string {
  const sorted = [...records].map(record => ({ recordId: record.recordId, sha256: record.sha256 }))
    .sort((left, right) => codeUnitCompare(left.recordId, right.recordId))
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex")
}

export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

export const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
