import type { DocumentExtraction, AmountItem } from "../../lib/document-agent/types"

export const materialText = "合成甲公司应向合成乙公司支付含税工程款。本期资料为2026-10-01至2026-10-31，计付基数100万元，支付比例80%，验收条件已满足，于2026-10-31到期；截至2026-10-31已付30万元，付款日期2026-10-30。本期资料包含全部应付款与付款，无其他扣项。"
export function paymentExtraction(): DocumentExtraction {
  const source = { paragraphIndex: 0, quote: materialText }
  const common = { payer: "合成甲公司", payee: "合成乙公司", scope: "合成分包合同", taxBasis: "含税" as const, basis: "本期" as const,
    periodStart: "2026-10-01", periodEnd: "2026-10-31", eventDate: null, dueDate: null, dueEvidence: null, conditionMet: null,
    ratio: null, rawRatio: null, ratioEvidence: null, source }
  const due: AmountItem = { ...common, label: "本期计付基数", kind: "计付基数", amountYuan: "1000000", rawAmount: "100万元", dueDate: "2026-10-31", dueEvidence: source, conditionMet: true,
    ratio: "0.8", rawRatio: "80%", ratioEvidence: source }
  const paid: AmountItem = { ...common, label: "本期已付", kind: "付款", amountYuan: "300000", rawAmount: "30万元", eventDate: "2026-10-30" }
  return { overview: "材料列明计付依据及收付款记录，仍须人工核对。", coverage: "完整", paymentCoverage: true, amounts: [due, paid], terms: [], events: [], disputes: [], gaps: [] }
}
export function evidenceExtraction(): DocumentExtraction {
  return { overview: "已整理材料记载的计量与付款事项。", coverage: "完整", paymentCoverage: false, amounts: [], terms: [],
    events: [{ title: "材料记载收取工程款", date: "2026-10-30", detail: "材料记载已付30万元，尚待人工核对。", nature: "材料记载", support: "材料支持", sources: [{ paragraphIndex: 0, quote: materialText }], conflicts: [] }],
    disputes: [{ title: "付款余额", detail: "应结合计付依据和完整付款资料核对。", eventIndexes: [0] }], gaps: [] }
}
