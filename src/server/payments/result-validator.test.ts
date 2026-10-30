import assert from "node:assert/strict"
import { test } from "node:test"
import type { LedgerRow, ProjectPaymentDraft } from "@/lib/payments/types"
import { buildPaymentReconciliationValue, paymentReconciliationValidator } from "./result-validator"
import { calculateLedger } from "./validation"
import { paymentReconciliationExportTemplate } from "./export-template"

export const paymentSource = { projectId: "project-a", materialId: "material-a", materialVersionId: "version-a", parseSnapshotId: "snapshot-a", fragmentId: "fragment-a", quote: "计量100万元，支付80%，已支付30万元。" }
export function paymentRows(): LedgerRow[] {
  const common = { taxBasis: "含税", basis: "本期", periodStart: "2026-10-01", periodEnd: "2026-10-30", payer: "总包", payee: "分包", confirmation: "已确认", source: paymentSource } as const
  return [{ ...common, rowId: "base", nature: "计付基数", amountFen: "100000000", ratio: "0.8", dueDate: "2026-10-30", conditionMet: true },
    { ...common, rowId: "paid", nature: "付款", amountFen: "30000000", eventDate: "2026-10-29", transactionId: "bank-001" }]
}
export function paymentDraft(): ProjectPaymentDraft { return { cutoff: "2026-10-30", contractId: "contract-a", rows: paymentRows(), facts: [] } }

test("AC-06/20: base × ratio computes amount due, distinct transactions never disappear", () => {
  const rows = paymentRows()
  assert.equal(calculateLedger(rows, "2026-10-30").calculation?.unpaidFen, "50000000")
  assert.equal(calculateLedger([...rows, { ...rows[1], rowId: "paid-2", transactionId: "bank-002" }], "2026-10-30").calculation?.unpaidFen, "20000000")
  const duplicate = calculateLedger([...rows, { ...rows[1], rowId: "same-bank" }], "2026-10-30")
  assert.equal(duplicate.calculation?.unpaidFen, "50000000")
  assert.ok(duplicate.notes.some(note => note.includes("去重")))
  assert.equal(calculateLedger([...rows, { ...rows[1], rowId: "unknown", transactionId: undefined }], "2026-10-30").calculation, null)
  assert.equal(calculateLedger([...rows, { ...rows[1], rowId: "conflict", amountFen: "10000000" }], "2026-10-30").calculation, null)
})

test("AC-20: half-up cents, negative balances, deductions and cumulative snapshots", () => {
  const rows = paymentRows()
  assert.equal(calculateLedger([{ ...rows[0], amountFen: "3", ratio: "0.5" }], "2026-10-30").calculation?.netDueFen, "2")
  assert.equal(calculateLedger([{ ...rows[0], amountFen: "-3", ratio: "0.5" }], "2026-10-30").calculation?.netDueFen, "-2")
  assert.equal(calculateLedger([rows[0], { ...rows[1], amountFen: "90000000" }], "2026-10-30").calculation?.unpaidFen, "-10000000")
  const deduction = { ...rows[0], rowId: "deduction", nature: "扣项", amountFen: "50000", includedInNet: true } as LedgerRow
  assert.equal(calculateLedger([...rows, deduction], "2026-10-30").calculation?.unpaidFen, "50000000")
  assert.equal(calculateLedger([...rows, { ...deduction, includedInNet: undefined }], "2026-10-30").calculation, null)
  assert.equal(calculateLedger([...rows, { ...deduction, includedInNet: false, periodStart: "2026-09-01", periodEnd: "2026-09-30" }], "2026-10-30").calculation, null)
  const cumulative = rows.map(row => ({ ...row, basis: "累计" as const }))
  const old = { ...cumulative[0], rowId: "old", periodStart: "2026-09-01", periodEnd: "2026-09-30", amountFen: "50000000" }
  assert.equal(calculateLedger([...cumulative, old], "2026-10-30").calculation?.netDueFen, "80000000")
  assert.equal(calculateLedger([...cumulative, { ...cumulative[0], rowId: "same-period" }], "2026-10-30").calculation, null)
  assert.equal(calculateLedger([cumulative[0], { ...cumulative[1], periodEnd: undefined }], "2026-10-30").calculation, null)
  assert.equal(calculateLedger([...cumulative, { ...deduction, basis: "累计", periodStart: undefined }], "2026-10-30").calculation, null)
})

test("AC-06/19: unknown confirmation, basis, due conditions and support remain drafts", async () => {
  for (const change of [{ confirmation: "未确认" }, { taxBasis: "不明" }, { basis: "不明" }, { dueDate: undefined }, { conditionMet: false }, { source: undefined }]) {
    const draft = paymentDraft(); Object.assign(draft.rows[0], change)
    const value = buildPaymentReconciliationValue(draft)
    assert.equal(value.status, "draft")
    const checked = await paymentReconciliationValidator(value)
    assert.equal(checked.status, "partial")
    assert.equal(checked.issues[0].code, "PAYMENT_DRAFT")
  }
})

test("AC-10/11/20: validator rejects result tampering and export reads only saved value", async () => {
  const value = buildPaymentReconciliationValue(paymentDraft())
  assert.equal((await paymentReconciliationValidator(value)).status, "valid")
  for (const raw of [{ ...value, status: "draft" }, { ...value, notes: [] }, { ...value, unknown: true }, { ...value, calculation: { ...value.calculation, unpaidFen: "70000000" } }, { ...value, rows: [...value.rows, value.rows[0]] }, { ...value, cutoff: "2026-02-30" }]) assert.equal((await paymentReconciliationValidator(raw)).status, "invalid")
  const text = paymentReconciliationExportTemplate.paragraphs(value).join("\n")
  assert.ok(text.includes("500000.00 元")); assert.ok(text.includes(paymentSource.quote)); assert.ok(text.includes("未调用模型"))
  assert.throws(() => paymentReconciliationExportTemplate.paragraphs({ ...value, calculation: null }))
})
