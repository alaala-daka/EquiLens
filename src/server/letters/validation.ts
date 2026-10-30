import type { CollectionLetterDraft, CollectionLetterValue, LetterEvidenceSnapshot, LetterFactSnapshot, LetterPaymentSnapshot } from "@/lib/letters/types"
import { canonicalJson, type ResultValidator } from "../results/validation"

const yuan = (fen: string) => {
  const value = BigInt(fen), negative = value < BigInt(0), absolute = negative ? -value : value
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`
}

export type LetterComposeInput = {
  cutoff: string
  contractTitle: string
  sender: string
  recipient: string
  demand: string
  plannedDate: string
  method: string
  address: string
  payment: LetterPaymentSnapshot | null
  facts: LetterFactSnapshot[]
  evidence?: LetterEvidenceSnapshot
}

/**
 * `collection-letter-v1` 的确定性正文：只写合同依据、应付/已付/余额、履行要求与拟发送安排，
 * 不自动添加利息、违约金、账户、法条、送达完成或诉讼行动；缺少的字段保留【待补充】。
 */
export function composeCollectionLetter(input: LetterComposeInput): CollectionLetterValue {
  const missing: string[] = []
  const field = (value: string, label: string) => { const trimmed = value.trim(); if (!trimmed) missing.push(label); return trimmed }
  const shown = (value: string, label: string) => value || `【待补充：${label}】`
  const contractTitle = field(input.contractTitle, "合同名称或编号")
  const sender = field(input.sender, "发函主体")
  const recipient = field(input.recipient, "收函主体")
  const demand = field(input.demand, "履行要求")
  const method = field(input.method, "拟用送达方式")
  const address = field(input.address, "拟送达地址")
  const plannedDate = field(input.plannedDate, "拟发送日期")
  const payment = input.payment
  if (!payment) missing.push("已到期未付金额及依据")
  if (input.evidence?.status === "incomplete") missing.push("证据整理报告中的未完成事项")
  const amountLine = payment
    ? `截至${input.cutoff}，所列材料对应的已到期净应付款为 ${yuan(payment.netDueFen)} 元，已列明付款 ${yuan(payment.paidFen)} 元，有条件测算余额为 ${yuan(payment.unpaidFen)} 元。以上金额以本次材料口径为限，仍须双方核对。`
    : `截至${input.cutoff}，应付、已付与余额尚需凭材料核对：待补充：已到期未付金额及依据。`
  const paragraphs = [
    "AI 草稿，待人工复核；本函尚未发送。",
    `${shown(recipient, "收函主体")}：`,
    `就《${shown(contractTitle, "合同名称或编号")}》所涉款项，现依据本次核对材料提请您方核对并履行付款义务。`,
    amountLine,
    `请贵方${shown(demand, "履行要求")}。如对金额、到期条件或付款归属有异议，请结合合同及对应凭证及时沟通核对。`,
    "本函不表示放弃双方依据合同享有的权利，也不确认本次材料范围外的事实或争议主张。",
    `发函方：${shown(sender, "发函主体")}`,
    `拟发送日期：${shown(plannedDate, "拟发送日期")}`,
    `拟用送达方式：${shown(method, "拟用送达方式")}`,
    `拟送达地址：${shown(address, "拟送达地址")}`,
  ]
  if (missing.length) paragraphs.push(`待补充事项：${[...new Set(missing)].join("；")}。`)
  return { schemaVersion: 1, templateVersion: "collection-letter-v1", cutoff: input.cutoff, contractTitle, sender, recipient, demand,
    plannedDate, method, address, payment, facts: input.facts, ...(input.evidence ? { evidence: input.evidence } : {}),
    paragraphs, missing: [...new Set(missing)], status: missing.length ? "draft" : "ready" }
}

const valueKeys = ["schemaVersion", "templateVersion", "cutoff", "contractTitle", "sender", "recipient", "demand", "plannedDate", "method",
  "address", "payment", "facts", "evidence", "paragraphs", "missing", "status"] as const

/** 结构、模板版本与正文一致性校验：任何被改写的字段或正文都会使成果 invalid。 */
export function parseCollectionLetterValue(raw: unknown): CollectionLetterValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !valueKeys.includes(key as never))) return null
  if (value.schemaVersion !== 1 || value.templateVersion !== "collection-letter-v1") return null
  if (!["draft", "ready"].includes(String(value.status))) return null
  if (!Array.isArray(value.paragraphs) || !paragraphsOk(value.paragraphs)) return null
  if (!Array.isArray(value.facts) || !Array.isArray(value.missing)) return null
  const payment = value.payment as LetterPaymentSnapshot | null
  if (payment && (typeof payment.unpaidFen !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(payment.unpaidFen))) return null
  let expected: CollectionLetterValue
  try {
    expected = composeCollectionLetter({
      cutoff: String(value.cutoff), contractTitle: String(value.contractTitle ?? ""), sender: String(value.sender ?? ""),
      recipient: String(value.recipient ?? ""), demand: String(value.demand ?? ""), plannedDate: String(value.plannedDate ?? ""),
      method: String(value.method ?? ""), address: String(value.address ?? ""), payment,
      facts: value.facts as LetterFactSnapshot[], ...(value.evidence ? { evidence: value.evidence as LetterEvidenceSnapshot } : {}),
    })
  } catch { return null }
  return canonicalJson(expected) === canonicalJson(raw) ? expected : null
}

function paragraphsOk(value: unknown[]) {
  return value.length > 0 && value.length <= 40 && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 3000)
}

export const collectionLetterValidator: ResultValidator = async raw => {
  const value = parseCollectionLetterValue(raw)
  if (!value) return { status: "invalid", issues: [{ code: "INVALID_LETTER", message: "催款函结构、正文或版本引用不一致。" }] }
  return value.status === "draft"
    ? { status: "partial", issues: [{ code: "LETTER_INCOMPLETE", message: value.missing.length ? `缺少：${value.missing.join("；")}` : "催款函仍为草稿。" }] }
    : { status: "valid", issues: [] }
}

/** 供服务端保存前组装：草稿引用已解析的数据，正文与状态由服务端派生。 */
export function buildCollectionLetter(draft: CollectionLetterDraft, resolved: { payment: LetterPaymentSnapshot | null; facts: LetterFactSnapshot[]; evidence?: LetterEvidenceSnapshot }) {
  const { payment: _payment, factVersionIds: _factVersionIds, evidence: _evidence, ...fields } = draft
  void _payment; void _factVersionIds; void _evidence
  return composeCollectionLetter({ ...fields, ...resolved })
}
