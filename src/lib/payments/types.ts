import type { SourceRef } from "../facts/types"

export type LedgerRowNature = "计量" | "计付基数" | "净应付" | "付款" | "扣项" | "未到期" | "争议" | "材料余额"
export type LedgerConfirmation = "未确认" | "已确认" | "待核实"

export type LedgerRow = {
  rowId: string
  nature: LedgerRowNature
  amountFen: string
  taxBasis: "含税" | "不含税" | "不明"
  basis: "本期" | "累计" | "不明"
  periodStart?: string
  periodEnd?: string
  eventDate?: string
  dueDate?: string
  conditionMet?: boolean
  ratio?: string
  payer?: string
  payee?: string
  confirmation: LedgerConfirmation
  source?: SourceRef
  factVersionIds?: string[]
  /** 扣项必须声明是否已计入净应付；已计入的扣项不再从余额中扣一次。 */
  includedInNet?: boolean
  note?: string
}

export type LedgerCalculation = { netDueFen: string; paidFen: string; unpaidFen: string; formula: string }

export type LedgerInput = {
  projectId: string
  contractId?: string
  ledgerId?: string
  baseRevisionId?: string
  cutoff: string
  rows: LedgerRow[]
  facts: { factId: string; factVersionId: string }[]
  createdBy: string
  reason: string
}

export type PaymentLedgerRevision = Omit<LedgerInput, "ledgerId"> & {
  ledgerId: string
  ledgerRevisionId: string
  baseRevisionId?: string
  version: number
  calculation: LedgerCalculation | null
  notes: string[]
  sha256: string
  createdAt: string
}

export class LedgerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LedgerError" }
}
