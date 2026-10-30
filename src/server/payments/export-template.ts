import { BusinessError } from "../projects/errors"
import { inspectPaymentReconciliation } from "./result-validator"
import { yuan } from "./validation"

export const paymentReconciliationExportTemplate = {
  version: "payment-reconciliation-v1",
  blocksInvalidResult: true,
  paragraphs(raw: unknown): string[] {
    const value = inspectPaymentReconciliation(raw)
    if (!value) throw new BusinessError("INVALID_INPUT", "款项成果校验未通过。")
    const lines = ["项目款项核对表", `核对截止日：${value.cutoff}`, `合同：${value.contractId ?? "未指定"}`,
      `状态：${value.status === "conditional" ? "有条件测算" : "草案"}`]
    value.rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.nature}：${yuan(BigInt(row.amountFen))} 元；${row.basis}；${row.taxBasis}；${row.confirmation}`)
      lines.push(`付款人：${row.payer ?? "未指定"}；收款人：${row.payee ?? "未指定"}；期间：${row.periodStart ?? "未指定"} 至 ${row.periodEnd ?? "未指定"}`)
      if (row.dueDate) lines.push(`到期日：${row.dueDate}；到期条件：${row.conditionMet === true ? "已满足" : "未确认"}`)
      if (row.eventDate) lines.push(`付款日：${row.eventDate}；凭证标识：${row.transactionId ?? "未登记"}`)
      if (row.ratio) lines.push(`支付比例：${row.ratio}`)
      if (row.nature === "扣项") lines.push(`已计入净应付：${row.includedInNet === undefined ? "未确认" : row.includedInNet ? "是" : "否"}`)
      if (row.source) lines.push(`来源：${row.source.materialVersionId ?? row.source.documentVersionId}/${row.source.parseSnapshotId}/${row.source.fragmentId ?? row.source.paragraphIndex ?? ""}；${row.source.locator ?? ""}；原文：${row.source.quote}`)
      for (const id of row.factVersionIds ?? []) lines.push(`事实版本：${id}`)
      if (row.note) lines.push(`说明：${row.note}`)
    })
    if (value.calculation) lines.push(`已到期应付净额：${yuan(BigInt(value.calculation.netDueFen))} 元`,
      `已核实付款：${yuan(BigInt(value.calculation.paidFen))} 元`, `已到期未付：${yuan(BigInt(value.calculation.unpaidFen))} 元`, `计算式：${value.calculation.formula}`)
    lines.push(...value.notes, "本表由服务端按保存的款项行确定性计算，未调用模型；测算不代表债权成立，须结合材料与人工复核使用。")
    return lines
  },
}
