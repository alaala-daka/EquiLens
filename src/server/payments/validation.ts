import { LedgerError, type LedgerCalculation, type LedgerInput, type LedgerRow, type PaymentLedgerRevision } from "@/lib/payments/types"
import type { SourceRef } from "@/lib/facts/types"

const fen = /^-?(?:0|[1-9]\d*)$/
const date = /^\d{4}-\d{2}-\d{2}$/
const required = (value: string | undefined, field: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new LedgerError("LEDGER_INPUT_INVALID", field + "无效。")
}
const checkDate = (value: string | undefined, field: string) => { if (value !== undefined && (!date.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z")))) throw new LedgerError("LEDGER_INPUT_INVALID", field + "无效。") }
function source(value: SourceRef | undefined, projectId: string) {
  if (!value) return
  if (value.projectId !== projectId) throw new LedgerError("LEDGER_PROJECT_MISMATCH", "来源不属于当前项目。")
  required(value.documentVersionId, "来源版本"); required(value.quote, "来源引文")
}

export function validateLedger(input: LedgerInput) {
  required(input.projectId, "项目"); required(input.createdBy, "记录人"); required(input.reason, "修改理由")
  checkDate(input.cutoff, "核对截止日")
  if (!input.rows.length) throw new LedgerError("LEDGER_INPUT_INVALID", "款项表不能为空。")
  if (new Set(input.rows.map(row => row.rowId)).size !== input.rows.length) throw new LedgerError("LEDGER_INPUT_INVALID", "款项行编号重复。")
  for (const row of input.rows) {
    required(row.rowId, "款项行编号")
    if (!fen.test(row.amountFen)) throw new LedgerError("LEDGER_AMOUNT_INVALID", "金额须为整数分字符串。")
    if (!["计量", "计付基数", "净应付", "付款", "扣项", "未到期", "争议", "材料余额"].includes(row.nature)) throw new LedgerError("LEDGER_INPUT_INVALID", "金额性质无效。")
    if (!["本期", "累计", "不明"].includes(row.basis)) throw new LedgerError("LEDGER_INPUT_INVALID", "本期/累计口径无效。")
    if (!["含税", "不含税", "不明"].includes(row.taxBasis)) throw new LedgerError("LEDGER_INPUT_INVALID", "税口径无效。")
    if (row.ratio !== undefined && !/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(row.ratio)) throw new LedgerError("LEDGER_INPUT_INVALID", "支付比例无效。")
    checkDate(row.periodStart, "起始日期"); checkDate(row.periodEnd, "截止日期"); checkDate(row.eventDate, "付款日期"); checkDate(row.dueDate, "到期日")
    source(row.source, input.projectId)
  }
  const facts = new Set<string>()
  for (const fact of input.facts) {
    if (!fact.factId || !fact.factVersionId) throw new LedgerError("LEDGER_INPUT_INVALID", "事实引用无效。")
    if (facts.has(fact.factId + ":" + fact.factVersionId)) throw new LedgerError("LEDGER_INPUT_INVALID", "事实引用重复。")
    facts.add(fact.factId + ":" + fact.factVersionId)
  }
}

export function calculateLedger(rows: LedgerRow[], cutoff: string): { calculation: LedgerCalculation | null; notes: string[] } {
  const unavailable = (note: string) => ({ calculation: null, notes: [note] })
  const due = rows.filter(row => row.nature === "净应付" || row.nature === "计付基数")
  if (!due.length) return unavailable("缺少净应付或计付基数，不能计算余额。")
  if (rows.some(row => row.confirmation !== "已确认")) return unavailable("存在未确认款项行，不能计算确定余额。")
  const basis = new Set(rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature)).map(row => row.basis))
  if (basis.size !== 1 || basis.has("不明")) return unavailable("本期/累计口径不一致或不明。")
  const tax = new Set(rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature)).map(row => row.taxBasis))
  if (tax.size !== 1 || tax.has("不明")) return unavailable("税口径不一致或不明。")
  const periods = new Set(rows.filter(row => ["净应付", "计付基数", "付款"].includes(row.nature)).map(row => `${row.periodStart ?? ""}:${row.periodEnd ?? ""}`))
  if (periods.size !== 1) return unavailable("款项期间不一致，需按同一期间核对。")
  const periodEnd = [...periods][0].split(":")[1]
  if (!periodEnd || periodEnd > cutoff) return unavailable("款项期间超过核对截止日。")
  if (due.some(row => !row.dueDate || row.dueDate > cutoff || row.conditionMet !== true)) return unavailable("到期条件或到期日尚未确认。")
  if (due.some(row => row.nature === "计付基数" && !row.ratio)) return unavailable("计付基数缺少支付比例。")

  const netRows = due.filter(row => row.nature === "净应付")
  const baseRows = due.filter(row => row.nature === "计付基数")
  let netDue = BigInt(0)
  if (netRows.length) for (const row of netRows) netDue += BigInt(row.amountFen)
  else for (const row of baseRows) netDue += applyRatio(BigInt(row.amountFen), row.ratio!)
  const deductions = rows.filter(row => row.nature === "扣项")
  for (const row of deductions) if (!row.includedInNet) netDue -= BigInt(row.amountFen)
  const payments = rows.filter(row => row.nature === "付款" && row.eventDate && row.eventDate <= cutoff)
  if (rows.some(row => row.nature === "付款" && !row.eventDate)) return unavailable("付款缺少日期，需核对归属。")
  const unique = new Map<string, LedgerRow>()
  for (const row of payments) {
    const key = [row.amountFen, row.eventDate, row.payer ?? "", row.payee ?? ""].join("|")
    if (unique.has(key)) continue
    unique.set(key, row)
  }
  let paid = BigInt(0)
  for (const row of unique.values()) paid += BigInt(row.amountFen)
  const unpaid = netDue - paid
  return { calculation: { netDueFen: netDue.toString(), paidFen: paid.toString(), unpaidFen: unpaid.toString(),
    formula: `${yuan(netDue)} − ${yuan(paid)} = ${yuan(unpaid)} 元` },
    notes: ["按已确认款项行有条件测算，尚待人工复核。", ...(deductions.length ? ["扣项已按是否计入净额处理，未重复扣减。"] : []), ...(unpaid < BigInt(0) ? ["余额为负，请核对超付或付款归属。"] : []), ...(unique.size !== payments.length ? ["同一笔付款在多处出现，已按金额、日期及主体去重。"] : [])] }
}

function yuan(value: bigint) {
  const negative = value < 0, absolute = negative ? -value : value
  return (negative ? "-" : "") + (absolute / BigInt(100)).toString() + "." + (absolute % BigInt(100)).toString().padStart(2, "0")
}
function applyRatio(amount: bigint, ratio: string) {
  const [whole, decimal = ""] = ratio.split(".")
  const units = BigInt(whole + decimal.padEnd(6, "0"))
  return amount * units / BigInt(1000000)
}

export function paymentAnalysis(input: LedgerInput, rows: LedgerRow[]): Pick<PaymentLedgerRevision, "calculation" | "notes"> {
  return calculateLedger(rows, input.cutoff)
}
