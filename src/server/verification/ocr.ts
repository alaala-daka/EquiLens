import type { VerificationFieldKey } from "../../lib/business/verification-fields"

/**
 * C4-OCR server-side provider boundary (frozen in round-four W0).
 *
 * The browser never learns whether OCR is configured; every capability question
 * is answered by this server-only adapter. The default adapter is fail-closed:
 * unless a verified endpoint/credential/region AND a tested certificate-kind
 * list are configured, `createOcrAdapter` returns an unavailable adapter whose
 * `available()` is false and whose `recognize` always rejects. No synthetic
 * provider is importable from production modules; `syntheticOcrAdapter` lives
 * only in `ocr-test-fixtures.ts` and a test asserts production code never
 * imports that file.
 *
 * No certificate kind is claimed as supported by this module: `supportedKinds()`
 * stays empty until a real account has been measured and the kind list has been
 * explicitly configured (spec 01 §6.1, §9.3). OCR confidence never proves
 * certificate authenticity (spec 01 §6.1).
 */

export type OcrBox = { x: number; y: number; width: number; height: number }

export type OcrExtractedField = {
  fieldKey: VerificationFieldKey
  /** Raw recognized value; normalization uses the shared field vocabulary. */
  valueText: string
  /** Provider confidence 0-100, or null when the provider does not report one. */
  confidence: number | null
  box?: OcrBox
}

export type OcrImageInfo = { format: "png" | "jpeg"; width: number; height: number }

export type OcrRequest = {
  projectId: string
  materialId: string
  versionId: string
  /** Certificate kind selected from the tested allowlist in task conditions. */
  certificateKind: string
  bytes: Uint8Array
  contentType: string
  sha256: string
  signal: AbortSignal
}

export type OcrUsage = {
  /** Number of billable provider requests this extraction used (>= 1). */
  calls: number
  /** Measured/estimated cost in fen when the provider reports it; null otherwise. */
  costFen: number | null
  /** Measured provider round-trip time. */
  timeMs: number
}

export type OcrExtraction = {
  provider: string
  providerVersion: string
  requestId: string
  image: OcrImageInfo
  fields: OcrExtractedField[]
  /** Recognized text when the provider produced a viewable original; null otherwise (never fabricated). */
  text: string | null
  usage: OcrUsage
}

export type OcrAdapter = {
  available(): boolean
  supportedKinds(): readonly string[]
  recognize(request: OcrRequest): Promise<OcrExtraction>
}

export type OcrErrorCode = "OCR_UNAVAILABLE" | "OCR_FAILED" | "OCR_TIMEOUT" | "OCR_REJECTED"

export class OcrError extends Error {
  constructor(readonly code: OcrErrorCode, message: string) {
    super(message)
    this.name = "OcrError"
  }
}

export function isOcrError(value: unknown): value is OcrError {
  return value instanceof OcrError
}

const unavailableMessage = "OCR 服务尚未验证，当前不可用。"

/** Fail-closed placeholder used whenever OCR capability is not proven. */
export function createUnavailableOcrAdapter(reason = unavailableMessage): OcrAdapter {
  const fail = async (): Promise<never> => {
    throw new OcrError("OCR_UNAVAILABLE", reason)
  }
  return {
    available: () => false,
    supportedKinds: () => [],
    recognize: fail,
  }
}

/** Environment variable names are documented in .env.example / README by the Lead. */
const requiredConfig = ["OCR_ENDPOINT", "OCR_ACCESS_KEY_ID", "OCR_ACCESS_KEY_SECRET", "OCR_REGION", "OCR_SUPPORTED_KINDS"] as const

/**
 * Create the production adapter. Because no provider implementation has been
 * verified against a real account yet, this factory stays fail-closed even when
 * the environment variables are present: it reports exactly which capability is
 * missing and never fabricates recognition. Tests inject the synthetic adapter
 * through the explicit lifecycle entry instead.
 */
export function createOcrAdapter(env: Record<string, string | undefined>): OcrAdapter {
  const missing = requiredConfig.filter(name => !env[name]?.trim())
  if (missing.length) return createUnavailableOcrAdapter(`OCR 服务未配置完整（缺少 ${missing.join("、")}），当前不可用。`)
  const kinds = (env.OCR_SUPPORTED_KINDS ?? "").split(",").map(kind => kind.trim()).filter(Boolean)
  if (!kinds.length) return createUnavailableOcrAdapter("OCR 证照种类实测清单为空，当前不可用。")
  // A configured endpoint is not a verified provider. Keep capability closed
  // until a measured adapter is implemented and reviewed, so no submission can
  // reach an unvalidated external account.
  return createUnavailableOcrAdapter(`OCR 服务尚未通过实测验证（已配置 ${kinds.length} 类证照），当前不可用。`)
}
