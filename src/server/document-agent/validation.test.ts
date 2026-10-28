import assert from "node:assert/strict"
import { test } from "node:test"
import { extractionSchema } from "./schema"
import { calculateDocumentAmounts, validateExtraction } from "./validation"
import { paymentExtraction, materialText } from "./test-fixtures"
import { submitReviewSchema } from "../contract-review/tasks/schema"

const paragraphs = [{ index: 0, text: materialText, inTable: false }]
test("AC-20: web payment arithmetic preserves exact units and computes 50 wan rather than 70 wan", () => {
  const data = extractionSchema.parse(paymentExtraction())
  assert.deepEqual(validateExtraction(data, paragraphs, "2026-10-31"), [])
  assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation?.unpaidFen, "50000000")
  data.amounts[1].rawAmount = "300000元"; data.amounts[1].amountYuan = "300000"
  assert.equal(validateExtraction(data, paragraphs, "2026-10-31")[0].id, "amount:1")
})
test("AC-19/20: contract terms, missing payment coverage and failed verification never become certain debt", () => {
  for (const patch of [{ paymentCoverage: false }, { gaps: ["缺少付款凭证。"] }, { amounts: [] }]) {
    const data = Object.assign(paymentExtraction(), patch)
    assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation, null)
  }
  assert.equal(calculateDocumentAmounts(paymentExtraction(), "2026-10-31", false).calculation, null)
})
test("AC-20/24: wrong amount units, fictional citations, invalid dates and percentage changes fail validation", () => {
  for (const mutate of [
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts[0].amountYuan = "10000" },
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts[0].source.quote = "假引文" },
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts[0].ratio = "0.6" },
  ]) { const data = paymentExtraction(); mutate(data); assert.equal(validateExtraction(data, paragraphs, "2026-10-31")[0].id, "amount:0") }
  const data = paymentExtraction(); data.amounts[0].dueDate = "2026-02-30"; assert.equal(extractionSchema.safeParse(data).success, false)
})
test("AC-20: mixed scope, overlap, duplicate payments, net deductions and negative balances remain distinct", () => {
  for (const mutate of [
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts[1].scope = "其他合同" },
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts.push(structuredClone(data.amounts[0])) },
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts[0].conditionMet = null },
    (data: ReturnType<typeof paymentExtraction>) => { data.amounts.push({ ...data.amounts[1], kind: "扣项" }) },
  ]) { const data = paymentExtraction(); mutate(data); assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation, null) }
  const duplicate = paymentExtraction(); duplicate.amounts.push(structuredClone(duplicate.amounts[1]))
  const deduped = calculateDocumentAmounts(duplicate, "2026-10-31", true)
  assert.equal(deduped.calculation?.unpaidFen, "50000000")
  assert.ok(deduped.calculationNotes.some(note => note.includes("去重")))
  const variant = paymentExtraction(); variant.amounts[1].scope = "上述合同2026-10-01至2026-10-31本期含税工程款"
  assert.equal(calculateDocumentAmounts(variant, "2026-10-31", true).calculation?.unpaidFen, "50000000")
  const conflict = paymentExtraction(); const other = structuredClone(conflict.amounts[1]); other.payer = "其他付款人"; conflict.amounts.push(other)
  assert.equal(calculateDocumentAmounts(conflict, "2026-10-31", true).calculation, null)
  const data = paymentExtraction(); data.amounts[1].amountYuan = "900000"
  assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation?.unpaidFen, "-10000000")
  data.amounts[0].kind = "净应付"; data.amounts[0].amountYuan = "800000"
  assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation?.unpaidFen, "-10000000")
})
test("AC-20: a matching gross base and explicit net describe one payable, while contradictory net blocks calculation", () => {
  const data = paymentExtraction()
  data.amounts.push({ ...structuredClone(data.amounts[0]), kind: "净应付", amountYuan: "800000", rawAmount: "80万元", ratio: null, ratioEvidence: null, rawRatio: null })
  assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation?.unpaidFen, "50000000")
  data.amounts[2].amountYuan = "810000"
  assert.equal(calculateDocumentAmounts(data, "2026-10-31", true).calculation, null)
})
test("AC-24: anonymous document tasks need a real cutoff and consent and cannot enable contract revision", () => {
  const request = { documentId: "00000000-0000-4000-8000-000000000001", revisionId: "00000000-0000-4000-8000-000000000002", task: "payment-reconciliation", asOf: "2026-10-31",
    context: { scene: "auto", role: "专业分包人", region: "" }, externalProcessingConsent: true, unreviewedMaterialsConsent: false, configurationId: "0".repeat(64) }
  assert.equal(submitReviewSchema.safeParse(request).success, true)
  for (const patch of [{ asOf: "2026-02-30" }, { generateRevision: true }, { externalProcessingConsent: false }, { task: "contract-review" }]) assert.equal(submitReviewSchema.safeParse({ ...request, ...patch }).success, false)
})
