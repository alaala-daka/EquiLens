import { createHash } from "node:crypto"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { CollectionLetter, DocumentAnalysis, LetterPlan } from "../../lib/document-agent/types"
import type { ReviewResult } from "../../../tools/contract-review/src/types"
import { formatFen } from "../../lib/document-agent/report"
import { blankDocx } from "../../lib/documents/docx"
import { validateUpload } from "../documents/validate"
import { readDocxInChild } from "../../../tools/contract-review/src/document"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { calculateDocumentAmounts, extractionIds, validateExtraction } from "./validation"

export const letterDraftHash = (letter: CollectionLetter) => createHash("sha256").update(JSON.stringify({ templateVersion: letter.templateVersion, title: letter.title, paragraphs: letter.paragraphs, missing: letter.missing })).digest("hex")
export function usablePayment(result: ReviewResult | undefined) {
  const analysis = result?.documentAnalysis, data = analysis?.extraction
  if (!result || !analysis || !data || analysis.task !== "payment-reconciliation" || !analysis.calculation || !analysis.audit.complete || analysis.audit.gaps.length || analysis.rejected.length ||
    extractionIds(data).some(id => !analysis.audit.checks.some(check => check.id === id && check.accepted)) || validateExtraction(data, result.paragraphs, analysis.cutoff).length) return null
  const calculated = calculateDocumentAmounts(data, analysis.cutoff, result.input.complete)
  return calculated.calculation && JSON.stringify(calculated.calculation) === JSON.stringify(analysis.calculation) && BigInt(analysis.calculation.unpaidFen) > BigInt(0) ? analysis : null
}
export function buildCollectionLetter(input: { plan: LetterPlan; title: string; cutoff: string; payment?: ReviewResult; evidence?: ReviewResult }): CollectionLetter {
  const missing: string[] = [], field = (value: string, label: string) => value.trim() || (missing.push(label), `【待补充：${label}】`)
  const sender = field(input.plan.sender, "发函主体"), recipient = field(input.plan.recipient, "收函主体"), contractTitle = field(input.plan.contractTitle, "合同名称或编号"), demand = field(input.plan.demand, "履行要求"), method = field(input.plan.method, "拟用送达方式"), address = field(input.plan.address, "拟送达地址")
  let payment = usablePayment(input.payment)
  if (payment && payment.cutoff !== input.cutoff) payment = null
  if (payment && payment.extraction!.amounts.some(row => ["净应付", "计付基数", "付款"].includes(row.kind) && (row.payer !== input.plan.recipient || row.payee !== input.plan.sender))) {
    missing.push("发函/收函主体与款项记录的对应关系"); payment = null
  }
  const calculation = payment?.calculation
  if (!calculation) missing.push("已到期未付金额及有效款项依据")
  const paragraphs = ["AI 草稿，待人工复核；本函尚未发送。", `${recipient}：`,
    `就《${contractTitle}》所涉款项，现依据本次所列材料提请贵方核对并履行付款义务。`,
    calculation ? `截至${input.cutoff}，所列材料对应的已到期净应付款为${formatFen(calculation.netDueFen)}，已列明付款为${formatFen(calculation.paidFen)}，有条件测算余额为${formatFen(calculation.unpaidFen)}。以上金额以本次材料口径为限，仍须双方核对。`
      : `截至${input.cutoff}，应付款、已付款及余额尚需凭材料核对：【待补充：已到期未付金额及依据】。`,
    `请贵方${demand}。如对金额、到期条件或付款归属有异议，请结合合同及对应凭证及时沟通核对。`,
    "本函不表示放弃双方依据合同享有的权利，也不确认本次材料范围外的事实或争议主张。",
    `发函方：${sender}`, `拟发送日期：${input.plan.plannedDate}`, `拟用送达方式：${method}`, `拟送达地址：${address}`]
  if (input.evidence?.documentAnalysis && (input.evidence.status !== "success" || input.evidence.documentAnalysis.rejected.length)) missing.push("所引用证据整理中的未完成事项")
  if (missing.length) paragraphs.push("待补充事项：" + [...new Set(missing)].join("；") + "。")
  return { templateVersion: "collection-letter-v1", title: "催款函（AI 草稿）", paragraphs, missing: [...new Set(missing)], auditPassed: false }
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
export async function renderCollectionLetter(letter: CollectionLetter, signal: AbortSignal) {
  if (!letter.auditPassed || letter.paragraphs.length > 30 || letter.paragraphs.some(text => text.length > 3000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))) throw new ReviewError("REVIEW_OUTPUT_INVALID")
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  const lines = [letter.title, ...letter.paragraphs]
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", lines.map(text => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`).join("")))
  const bytes = Buffer.from(zipSync(files)); await validateUpload(bytes)
  const parsed = await readDocxInChild(bytes, signal)
  if (JSON.stringify(parsed.map(item => item.text)) !== JSON.stringify(lines)) throw new ReviewError("REVIEW_REVISION_EXPORT_FAILED")
  return bytes
}
export function letterVerificationAllowed(analysis: DocumentAnalysis) {
  return Boolean(analysis.letter && analysis.audit.complete && analysis.audit.checks.some(check => check.id === "letter" && check.accepted) &&
    !analysis.rejected.length && analysis.audit.checks.every(check => check.accepted) && !analysis.audit.gaps.length)
}
