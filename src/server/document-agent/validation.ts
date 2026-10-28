import type { AmountItem, Citation, DocumentAnalysis, DocumentExtraction } from "../../lib/document-agent/types"
import type { Paragraph } from "../../../tools/contract-review/src/types"
import { applyRatio, fenToYuan, yuanToFen } from "./amount"

export const extractionIds = (data: DocumentExtraction) => ["overview", ...data.amounts.map((_, i) => "amount:" + i), ...data.terms.map((_, i) => "term:" + i),
  ...data.events.map((_, i) => "event:" + i), ...data.disputes.map((_, i) => "dispute:" + i)]
/** Ratio is an operative input only for a gross payable base. Raw exchanges retain the original model response. */
export function normalizeExtraction(data: DocumentExtraction): DocumentExtraction {
  return { ...data, amounts: data.amounts.map(row => row.kind === "计付基数" ? row : { ...row, ratio: null, rawRatio: null, ratioEvidence: null }) }
}
export function citationValid(source: Citation, paragraphs: Paragraph[]) { return Boolean(source.quote.trim() && paragraphs.find(item => item.index === source.paragraphIndex)?.text.includes(source.quote)) }
function rawFen(raw: string): string | null {
  const match = raw.replace(/\s/g, "").match(/^(?:人民币)?(\d+(?:\.\d{1,10})?)(元|万元|亿元|分)$/)
  if (!match) return null
  const scale = { 元: BigInt(100), 万元: BigInt(1000000), 亿元: BigInt(10000000000), 分: BigInt(1) }[match[2] as "元"]
  const [whole, decimal = ""] = match[1].split("."), denominator = BigInt(10) ** BigInt(decimal.length), numerator = BigInt(whole + decimal) * scale
  return numerator % denominator === BigInt(0) ? (numerator / denominator).toString() : null
}
const ratioUnits = (value: string) => { const [whole, decimal = ""] = value.split("."); return BigInt(whole + decimal.padEnd(6, "0")) }
export function validateExtraction(data: DocumentExtraction, paragraphs: Paragraph[], cutoff: string) {
  const rejected: DocumentAnalysis["rejected"] = []
  const fail = (id: string, reason: string) => { if (!rejected.some(item => item.id === id)) rejected.push({ id, reason }) }
  data.amounts.forEach((item, index) => {
    const id = "amount:" + index
    if (!citationValid(item.source, paragraphs) || !item.source.quote.includes(item.rawAmount) || rawFen(item.rawAmount) !== yuanToFen(item.amountYuan)) fail(id, "原文金额、单位或引文无法核对，该笔未用于计算。")
    if (item.periodStart && item.periodEnd && item.periodStart > item.periodEnd) fail(id, "款项期间起止不一致。")
    if (item.dueEvidence && !citationValid(item.dueEvidence, paragraphs)) fail(id, "到期依据引文无效。")
    if (item.dueDate && (!item.dueEvidence || ![item.dueDate, item.dueDate.replace(/-(\d{2})-(\d{2})$/, (_, month, day) => `年${Number(month)}月${Number(day)}日`)].some(day => item.dueEvidence!.quote.includes(day)))) fail(id, "缺少明确对应所填日期的到期依据。")
    if (item.ratio !== null) {
      const percent = item.rawRatio?.match(/^(\d+(?:\.\d{1,4})?)%$/)
      if (!percent || !item.ratioEvidence || !citationValid(item.ratioEvidence, paragraphs) || !item.ratioEvidence.quote.includes(item.rawRatio!) || ratioUnits(percent[1]) / BigInt(100) !== ratioUnits(item.ratio)) fail(id, "支付比例及原文无法核对。")
    }
  })
  data.terms.forEach((item, index) => { if (item.sources.some(source => !citationValid(source, paragraphs))) fail("term:" + index, "付款约定的引文无效。") })
  data.events.forEach((item, index) => {
    if ([...item.sources, ...item.conflicts].some(source => !citationValid(source, paragraphs))) fail("event:" + index, "证据引文无法定位到本次原文。")
    if ((item.support === "材料冲突") !== Boolean(item.conflicts.length)) fail("event:" + index, "冲突状态与冲突材料不一致。")
    if (item.date && item.date > cutoff) fail("event:" + index, "事件超出本次核对截止日。")
  })
  data.disputes.forEach((item, index) => { if (item.eventIndexes.some(id => !data.events[id] || rejected.some(rejected => rejected.id === "event:" + id))) fail("dispute:" + index, "争点引用了无效或不存在的证据。") })
  return rejected
}

/** Conditional arithmetic on cited material, never human confirmation or a final debt determination. */
export function calculateDocumentAmounts(data: DocumentExtraction, cutoff: string, allowed: boolean): Pick<DocumentAnalysis, "calculation" | "calculationNotes"> {
  const unavailable = (note: string) => ({ calculation: null, calculationNotes: [note] })
  if (!allowed) return unavailable("部分资料或机器核对尚未通过，暂不合计欠款。")
  if (!data.paymentCoverage || data.gaps.length || data.coverage !== "完整") return unavailable("收付款资料或到期依据未齐，暂不合计欠款。")
  const rows = data.amounts.filter(item => ["计付基数", "净应付", "付款", "扣项"].includes(item.kind))
  const dueCandidates = rows.filter(item => item.kind === "计付基数" || item.kind === "净应付"), paid = rows.filter(item => item.kind === "付款")
  const samePeriod = (left: AmountItem, right: AmountItem) => JSON.stringify([left.payer, left.payee, left.scope, left.taxBasis, left.basis, left.periodStart, left.periodEnd]) === JSON.stringify([right.payer, right.payee, right.scope, right.taxBasis, right.basis, right.periodStart, right.periodEnd])
  const replacedBases = new Set<AmountItem>()
  for (const base of dueCandidates.filter(row => row.kind === "计付基数")) {
    const net = dueCandidates.filter(row => row.kind === "净应付" && samePeriod(base, row))
    if (!net.length) continue
    if (net.length !== 1 || base.ratio === null || !base.ratioEvidence || applyRatio(yuanToFen(base.amountYuan), base.ratio) !== yuanToFen(net[0].amountYuan)) return unavailable("同一期间的计付基数、比例与净额不一致，需核对后再合计。")
    replacedBases.add(base)
  }
  const due = dueCandidates.filter(row => !replacedBases.has(row))
  if (!due.length || !paid.length) return unavailable("缺少实际应付款或完整付款记录；合同约定不能直接作为欠款。")
  if (rows.some(row => !row.payer || !row.payee || row.taxBasis === "不明" || row.basis === "不明")) return unavailable("付款主体、税口径或本期/累计口径不一致或不明。")
  const scopeText = (value: string) => value.replace(/[\s，。；、,:：;（）()]/g, "").replace(/含税|不含税/g, "")
    .replace(/(?:上述|该)合同/g, "合同").replace(/本合同/g, "合同").replace(/\d{4}-\d{2}-\d{2}(?:至\d{4}-\d{2}-\d{2})?/g, "")
  const scopeCompatible = (left: string, right: string) => {
    const a = scopeText(left), b = scopeText(right)
    if (!a || !b) return false
    if (a === b || a.includes(b) || b.includes(a)) return true
    // 「上述合同本期工程款」这类不含合同名的概括写法可视为同一范围；出现不同合同名（如“其他合同”）仍拒绝。
    const core = (value: string) => scopeText(value).replace(/合同|本期|累计|工程款|款项|含税|不含税/g, "")
    return !core(left) || !core(right)
  }
  if (rows.some(row => !scopeCompatible(row.scope, rows[0].scope))) return unavailable("涉及多个款项归属，需先分别核对，不直接合计。")
  if (due.some(row => !row.dueDate || !row.dueEvidence || row.conditionMet !== true)) return unavailable("实际到期条件尚未核实。")
  if (paid.some(row => !row.eventDate)) return unavailable("付款日期尚未核实。")
  const select = (values: AmountItem[], overlap: boolean): AmountItem[] | null => {
    if (!values.length) return []
    if (new Set(values.map(row => row.basis)).size !== 1 || values.some(row => !row.periodStart || !row.periodEnd)) return null
    const eligible = values.filter(row => row.periodEnd! <= cutoff)
    if (values[0].basis === "累计") {
      if (new Set(values.map(row => row.periodStart)).size !== 1) return null
      const latest = [...eligible].sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!))
      if (latest.length > 1 && latest[0].periodEnd === latest[1].periodEnd) return null
      return latest.slice(0, 1)
    }
    const sorted = [...eligible].sort((a, b) => a.periodStart!.localeCompare(b.periodStart!))
    if (overlap && sorted.some((row, index) => index > 0 && row.periodStart! <= sorted[index - 1].periodEnd!)) return null
    return sorted
  }
  const payable = select(due, true), payments = select(paid.filter(row => row.eventDate! <= cutoff), false)
  if (paid.some(row => row.eventDate! <= cutoff && row.periodEnd! > cutoff)) return unavailable("付款所属期间超出截止日，需先核对统计口径。")
  if (!payable || !payments || !payable.length) return unavailable("本期/累计、期间重叠或累计快照存在冲突。")
  const deductions = rows.filter(row => row.kind === "扣项")
  if (deductions.length) return unavailable("存在扣抵项目，需确认是否已计入净额后再合计。")
  const paymentGroups = new Map<string, AmountItem[]>()
  for (const row of payments) {
    const key = JSON.stringify([row.amountYuan, row.eventDate])
    paymentGroups.set(key, [...(paymentGroups.get(key) ?? []), row])
  }
  const uniquePayments: AmountItem[] = []
  let deduped = false
  for (const group of paymentGroups.values()) {
    if (group.length > 1) {
      // 同一笔付款可能同时出现在回单和汇总表；只有金额、日期、主体与口径完全一致时才视为重复记载。
      if (new Set(group.map(row => JSON.stringify([row.payer, row.payee, row.scope, row.taxBasis]))).size > 1)
        return unavailable("同日同额付款的付款人或口径不一致，需核对归属后再合计。")
      deduped = true
    }
    uniquePayments.push(group[0])
  }
  let netDue = BigInt(0), paidFen = BigInt(0)
  for (const row of payable) {
    if (row.dueDate! > cutoff) continue
    if (row.kind === "计付基数" && (row.ratio === null || !row.ratioEvidence)) return unavailable("计付基数缺少已核对支付比例，不能作为净应付款。")
    netDue += BigInt(row.kind === "计付基数" ? applyRatio(yuanToFen(row.amountYuan), row.ratio!) : yuanToFen(row.amountYuan))
  }
  for (const row of uniquePayments) paidFen += BigInt(yuanToFen(row.amountYuan))
  const unpaid = netDue - paidFen
  return { calculation: { netDueFen: netDue.toString(), paidFen: paidFen.toString(), unpaidFen: unpaid.toString(), formula: `${fenToYuan(netDue.toString())} − ${fenToYuan(paidFen.toString())} = ${fenToYuan(unpaid.toString())} 元` },
    calculationNotes: ["按本次所列材料有条件测算，尚待人工核对。", ...(deduped ? ["同一笔付款在多处材料中出现，已按金额、日期、主体及口径去重，仍需核对凭证。"] : []), ...(unpaid < BigInt(0) ? ["余额为负，请核对超付或付款归属。"] : [])] }
}
