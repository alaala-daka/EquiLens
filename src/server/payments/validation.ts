import { LedgerError, type LedgerCalculation, type LedgerInput, type LedgerRow, type PaymentLedgerRevision } from "@/lib/payments/types"
import type { SourceAnchor } from "@/lib/facts/types"

const fen = /^-?(?:0|[1-9]\d*)$/
const date = /^\d{4}-\d{2}-\d{2}$/
const required = (value: string | undefined, field: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new LedgerError("LEDGER_INPUT_INVALID", field + "无效。")
}
const checkDate = (value: string | undefined, field: string) => { if (value !== undefined && (!date.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z")))) throw new LedgerError("LEDGER_INPUT_INVALID", field + "无效。") }
function source(value: SourceAnchor | undefined, projectId: string) {
  if (!value) return
  if (value.projectId !== projectId) throw new LedgerError("LEDGER_PROJECT_MISMATCH", "来源不属于当前项目。")
  required(value.materialVersionId ?? value.documentVersionId, "来源版本"); required(value.quote, "来源引文")
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
    if (!["未确认", "已确认", "待核实"].includes(row.confirmation)) throw new LedgerError("LEDGER_INPUT_INVALID", "确认状态无效。")
    if (row.transactionId !== undefined) required(row.transactionId, "付款凭证标识")
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

export function calculateLedger(inputRows: LedgerRow[], cutoff: string): { calculation: LedgerCalculation | null; notes: string[] } {
  const unavailable = (note: string) => ({ calculation: null, notes: [note] })
  let rows = inputRows
  // Cumulative figures are snapshots, never a series of transactions to add.
  const financial = rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature))
  if (financial.some(row => row.basis === "累计")) {
    if (financial.some(row => row.basis !== "累计")) return unavailable("本期/累计口径不一致或不明。")
    if (financial.some(row => !row.periodStart || !row.periodEnd || row.periodStart > row.periodEnd)) return unavailable("累计款项缺少有效统计期间，不能选择截止期快照。")
    const selected = new Set<string>()
    for (const nature of ["净应付", "计付基数", "付款", "扣项"]) {
      const snapshots = financial.filter(row => row.nature === nature && row.periodEnd && row.periodEnd <= cutoff)
      const latest = snapshots.map(row => row.periodEnd!).sort().at(-1)
      const latestRows = snapshots.filter(row => row.periodEnd === latest)
      if (latestRows.length > 1) return unavailable("同一截止期存在多个累计快照，需确认采用值。")
      latestRows.forEach(row => selected.add(row.rowId))
    }
    rows = rows.filter(row => !financial.includes(row) || selected.has(row.rowId))
  }
  const due = rows.filter(row => row.nature === "净应付" || row.nature === "计付基数")
  if (!due.length) return unavailable("缺少净应付或计付基数，不能计算余额。")
  if (rows.some(row => row.confirmation !== "已确认")) return unavailable("存在未确认款项行，不能计算确定余额。")
  const relevant = rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature))
  if (relevant.some(row => !row.source && !row.factVersionIds?.length)) return unavailable("款项缺少材料来源或事实版本，需补充核对依据。")
  const parties = new Set(relevant.map(row => `${row.payer ?? ""}|${row.payee ?? ""}`))
  if (parties.size !== 1 || relevant.some(row => !row.payer?.trim() || !row.payee?.trim())) return unavailable("付款双方不一致或未明确，需核对款项归属。")
  const basis = new Set(rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature)).map(row => row.basis))
  if (basis.size !== 1 || basis.has("不明")) return unavailable("本期/累计口径不一致或不明。")
  const tax = new Set(rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature)).map(row => row.taxBasis))
  if (tax.size !== 1 || tax.has("不明")) return unavailable("税口径不一致或不明。")
  const periods = new Set(rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature)).map(row => `${row.periodStart ?? ""}:${row.periodEnd ?? ""}`))
  if (periods.size !== 1) return unavailable("款项期间不一致，需按同一期间核对。")
  const periodEnd = [...periods][0].split(":")[1]
  if (!periodEnd || periodEnd > cutoff) return unavailable("款项期间超过核对截止日。")
  if (due.some(row => !row.dueDate || row.dueDate > cutoff || row.conditionMet !== true)) return unavailable("到期条件或到期日尚未确认。")
  if (due.some(row => row.nature === "计付基数" && !row.ratio)) return unavailable("计付基数缺少支付比例。")

  const netRows = due.filter(row => row.nature === "净应付")
  const baseRows = due.filter(row => row.nature === "计付基数")
  let netDue = BigInt(0)
  if (netRows.length && baseRows.length) {
    const net = netRows.reduce((sum, row) => sum + BigInt(row.amountFen), BigInt(0))
    const base = baseRows.reduce((sum, row) => sum + applyRatio(BigInt(row.amountFen), row.ratio!), BigInt(0))
    if (net !== base) return unavailable("净应付与计付基数按比例计算不一致，需核对扣抵及金额口径。")
  }
  if (netRows.length) for (const row of netRows) netDue += BigInt(row.amountFen)
  else for (const row of baseRows) netDue += applyRatio(BigInt(row.amountFen), row.ratio!)
  const deductions = rows.filter(row => row.nature === "扣项")
  if (deductions.some(row => row.includedInNet === undefined)) return unavailable("扣项是否已计入净应付尚未确认。")
  for (const row of deductions) if (!row.includedInNet) netDue -= BigInt(row.amountFen)
  const payments = rows.filter(row => row.nature === "付款" && row.eventDate && row.eventDate <= cutoff)
  if (rows.some(row => row.nature === "付款" && !row.eventDate)) return unavailable("付款缺少日期，需核对归属。")
  const unique = new Map<string, LedgerRow>()
  for (const row of payments) {
    const signature = [row.amountFen, row.eventDate, row.payer, row.payee, row.periodStart, row.periodEnd, row.taxBasis, row.basis].join("|")
    const id = row.transactionId ? [row.payer, row.payee, row.transactionId].join("|") : undefined
    for (const previous of unique.values()) {
      const previousSignature = [previous.amountFen, previous.eventDate, previous.payer, previous.payee, previous.periodStart, previous.periodEnd, previous.taxBasis, previous.basis].join("|")
      if (signature === previousSignature && (!id || !previous.transactionId)) return unavailable("存在同日同额疑似重复付款，需凭证标识确认是否同一笔。")
    }
    if (id && unique.has(id)) {
      const previous = unique.get(id)!
      if ([previous.amountFen, previous.eventDate, previous.periodStart, previous.periodEnd, previous.taxBasis, previous.basis].join("|") !== [row.amountFen, row.eventDate, row.periodStart, row.periodEnd, row.taxBasis, row.basis].join("|")) return unavailable("相同付款凭证的金额或口径冲突，需核对。")
      continue
    }
    unique.set(id ?? row.rowId, row)
  }
  let paid = BigInt(0)
  for (const row of unique.values()) paid += BigInt(row.amountFen)
  const unpaid = netDue - paid
  return { calculation: { netDueFen: netDue.toString(), paidFen: paid.toString(), unpaidFen: unpaid.toString(),
    formula: `${yuan(netDue)} − ${yuan(paid)} = ${yuan(unpaid)} 元` },
    notes: ["按已确认款项行有条件测算，尚待人工复核。", ...(deductions.length ? ["扣项已按是否计入净额处理，未重复扣减。"] : []), ...(unpaid < BigInt(0) ? ["余额为负，请核对超付或付款归属。"] : []), ...(unique.size !== payments.length ? ["相同付款凭证已去重，全部来源仍保留。"] : [])] }
}

export function yuan(value: bigint) {
  const negative = value < 0, absolute = negative ? -value : value
  return (negative ? "-" : "") + (absolute / BigInt(100)).toString() + "." + (absolute % BigInt(100)).toString().padStart(2, "0")
}
function applyRatio(amount: bigint, ratio: string) {
  const [whole, decimal = ""] = ratio.split(".")
  const units = BigInt(whole + decimal.padEnd(6, "0"))
  const product = amount * units
  const absolute = product < BigInt(0) ? -product : product
  const rounded = (absolute + BigInt(500000)) / BigInt(1000000)
  return product < BigInt(0) ? -rounded : rounded
}

export function paymentAnalysis(input: LedgerInput, rows: LedgerRow[]): Pick<PaymentLedgerRevision, "calculation" | "notes"> {
  return calculateLedger(rows, input.cutoff)
}
