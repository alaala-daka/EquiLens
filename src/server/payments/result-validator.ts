import { z } from "zod"
import type { PaymentReconciliationValue, ProjectPaymentDraft } from "@/lib/payments/types"
import { canonicalJson, type ResultValidator } from "../results/validation"
import { calculateLedger } from "./validation"

const text = z.string().trim().min(1).max(500)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z")
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
})
const sourceSchema = z.object({
  projectId: text, quote: z.string().min(1).max(20000), parseSnapshotId: text,
  fragmentId: text.optional(), paragraphIndex: z.number().int().min(0).optional(),
  materialId: text.optional(), materialVersionId: text.optional(),
  documentId: text.optional(), documentVersionId: text.optional(), locator: text.optional(),
}).strict()
const rowSchema = z.object({
  rowId: text,
  nature: z.enum(["计量", "计付基数", "净应付", "付款", "扣项", "未到期", "争议", "材料余额"]),
  amountFen: z.string().regex(/^-?(?:0|[1-9]\d{0,29})$/),
  taxBasis: z.enum(["含税", "不含税", "不明"]), basis: z.enum(["本期", "累计", "不明"]),
  periodStart: day.optional(), periodEnd: day.optional(), eventDate: day.optional(), dueDate: day.optional(),
  conditionMet: z.boolean().optional(), ratio: z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/).optional(),
  payer: text.optional(), payee: text.optional(), transactionId: text.optional(),
  confirmation: z.enum(["未确认", "已确认", "待核实"]), includedInNet: z.boolean().optional(),
  note: z.string().max(2000).optional(), source: sourceSchema.optional(), factVersionIds: z.array(text).max(200).optional(),
}).strict().refine(row => !row.periodStart || !row.periodEnd || row.periodStart <= row.periodEnd)

export const projectPaymentDraftSchema = z.object({
  cutoff: day, contractId: text.optional(), rows: z.array(rowSchema).min(1).max(200),
  facts: z.array(z.object({ factId: text, factVersionId: text }).strict()).max(200),
}).strict().refine(value => new Set(value.rows.map(row => row.rowId)).size === value.rows.length)
  .refine(value => new Set(value.facts.map(fact => fact.factVersionId)).size === value.facts.length)
  .refine(value => value.rows.every(row => (row.factVersionIds ?? []).every(id => value.facts.some(fact => fact.factVersionId === id))))

export function parseProjectPaymentDraft(raw: unknown): ProjectPaymentDraft | null {
  const parsed = projectPaymentDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function buildPaymentReconciliationValue(draft: ProjectPaymentDraft): PaymentReconciliationValue {
  const saved = JSON.parse(JSON.stringify(draft)) as ProjectPaymentDraft
  const computed = calculateLedger(saved.rows, saved.cutoff)
  return { schemaVersion: 1, ...saved, ...computed, status: computed.calculation ? "conditional" : "draft" }
}

export function inspectPaymentReconciliation(raw: unknown): PaymentReconciliationValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== 1 || Object.keys(record).some(key => !["schemaVersion", "cutoff", "contractId", "rows", "facts", "calculation", "notes", "status"].includes(key))) return null
  const draft = parseProjectPaymentDraft({ cutoff: record.cutoff, ...(record.contractId === undefined ? {} : { contractId: record.contractId }), rows: record.rows, facts: record.facts })
  if (!draft) return null
  const expected = buildPaymentReconciliationValue(draft)
  try { if (canonicalJson(expected) !== canonicalJson(raw)) return null } catch { return null }
  return expected
}

export const paymentReconciliationValidator: ResultValidator = async raw => {
  const value = inspectPaymentReconciliation(raw)
  if (!value) return { status: "invalid", issues: [{ code: "INVALID_PAYMENT", message: "款项结构或计算结果不一致。" }] }
  return value.calculation
    ? { status: "valid", issues: [] }
    : { status: "partial", issues: [{ code: "PAYMENT_DRAFT", message: value.notes.join("；") }] }
}
