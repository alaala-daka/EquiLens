import type { LedgerRow, PaymentReconciliationValue, ProjectPaymentDraft } from "@/lib/payments/types"

export function paymentFen(value: string): string | null {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const amount = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0"))
  return (match[1] && amount ? -amount : amount).toString()
}

export function paymentYuan(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return "金额待核对"
  const amount = BigInt(value), absolute = amount < BigInt(0) ? -amount : amount
  return `${amount < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`
}

export function newPaymentRow(rowId: string): LedgerRow {
  return { rowId, nature: "净应付", amountFen: "0", taxBasis: "不明", basis: "不明", confirmation: "未确认" }
}

export function replacePaymentRow(rows: LedgerRow[], row: LedgerRow): LedgerRow[] {
  return rows.some(item => item.rowId === row.rowId) ? rows.map(item => item.rowId === row.rowId ? row : item) : [...rows, row]
}

export function emptyPaymentDraft(): ProjectPaymentDraft { return { cutoff: "", rows: [], facts: [] } }

export function paymentDraftFromValue(value: PaymentReconciliationValue): ProjectPaymentDraft {
  return { cutoff: value.cutoff, ...(value.contractId ? { contractId: value.contractId } : {}), rows: structuredClone(value.rows), facts: structuredClone(value.facts) }
}

export function paymentValue(raw: unknown): PaymentReconciliationValue | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as PaymentReconciliationValue
  return value.schemaVersion === 1 && Array.isArray(value.rows) && Array.isArray(value.facts) && Array.isArray(value.notes) ? value : null
}

/** Preserve one operation id across a failed request; a changed edit gets a new id. */
export function paymentOperation(previous: { signature: string; id: string } | null, signature: string, create: () => string) {
  return previous?.signature === signature ? previous : { signature, id: create() }
}
