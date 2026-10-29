/**
 * C4 bid-verification field vocabulary (frozen in round-four W0).
 *
 * Shared by the OCR/manual field writer (C4-OCR) and the requirement/comparison
 * engine (C4-VERIFY) so independently written modules agree on field keys and on
 * how raw certificate values are normalized. Text only: no float amounts and no
 * provider-specific names. This module is client-safe and must not import
 * node:*, server-only or database modules.
 *
 * Values are stored raw (`valueText`) plus normalized (`normalizedValue`); the
 * comparison engine may only compare normalized values. Dates are ISO
 * `YYYY-MM-DD` after normalization; identifiers drop whitespace and are
 * upper-cased; text collapses whitespace/NFKC.
 */
export const VERIFICATION_FIELD_KEYS = [
  "subject_name",
  "unified_social_credit_code",
  "certificate_kind",
  "certificate_level",
  "certificate_number",
  "holder_name",
  "holder_id_number",
  "qualification_major",
  "registered_unit",
  "issue_date",
  "expiry_date",
] as const

export type VerificationFieldKey = (typeof VERIFICATION_FIELD_KEYS)[number]
export type VerificationFieldType = "text" | "identifier" | "date" | "enum"

export const VERIFICATION_FIELD_LABELS: Record<VerificationFieldKey, string> = {
  subject_name: "主体名称",
  unified_social_credit_code: "统一社会信用代码",
  certificate_kind: "证照类别",
  certificate_level: "证照等级",
  certificate_number: "证书编号",
  holder_name: "人员姓名",
  holder_id_number: "人员证件号码",
  qualification_major: "资格专业",
  registered_unit: "注册单位",
  issue_date: "发证日期",
  expiry_date: "有效期至",
}

export const VERIFICATION_FIELD_TYPES: Record<VerificationFieldKey, VerificationFieldType> = {
  subject_name: "text",
  unified_social_credit_code: "identifier",
  certificate_kind: "enum",
  certificate_level: "enum",
  certificate_number: "identifier",
  holder_name: "text",
  holder_id_number: "identifier",
  qualification_major: "text",
  registered_unit: "text",
  issue_date: "date",
  expiry_date: "date",
}

export function isVerificationFieldKey(value: unknown): value is VerificationFieldKey {
  return typeof value === "string" && (VERIFICATION_FIELD_KEYS as readonly string[]).includes(value)
}

/** Collapse all whitespace runs (including line breaks and full-width spaces) to one space. */
export function collapseWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

const datePatterns = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/,
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
]

/** Normalize to ISO `YYYY-MM-DD`; returns null when the value cannot be parsed. */
export function normalizeDateValue(raw: string): string | null {
  const text = raw.normalize("NFKC").trim()
  for (const pattern of datePatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  }
  return null
}

/** Normalize a raw certificate value for the given frozen field key. */
export function normalizeFieldValue(key: VerificationFieldKey, raw: string): string {
  if (typeof raw !== "string") return ""
  const type = VERIFICATION_FIELD_TYPES[key]
  if (type === "date") return normalizeDateValue(raw) ?? ""
  if (type === "identifier") return collapseWhitespace(raw).replace(/\s+/g, "").toUpperCase()
  return collapseWhitespace(raw)
}

/** Compare two raw values using the frozen field semantics (dates and identifiers included). */
export function fieldValuesEqual(key: VerificationFieldKey, left: string, right: string): boolean {
  const a = normalizeFieldValue(key, left), b = normalizeFieldValue(key, right)
  return a.length > 0 && a === b
}

/**
 * Citation matching per spec 01 §7.2: whitespace may be normalized but the
 * substance cannot change. Both fragments are compared after NFKC + whitespace
 * collapsing; an empty quote never matches.
 */
export function quotesMatch(fragmentText: string, quote: string): boolean {
  if (typeof fragmentText !== "string" || typeof quote !== "string") return false
  const normalizedQuote = collapseWhitespace(quote)
  if (!normalizedQuote) return false
  return collapseWhitespace(fragmentText).includes(normalizedQuote)
}
