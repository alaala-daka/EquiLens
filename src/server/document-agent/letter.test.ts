import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCollectionLetter, renderCollectionLetter, usablePayment } from "./letter"
import { letterPlanSchema } from "./schema"
import { paymentExtraction } from "./test-fixtures"
import { calculateDocumentAmounts, extractionIds } from "./validation"
import type { ReviewResult } from "../../../tools/contract-review/src/types"

export const plan = { sender: "合成乙公司", recipient: "合成甲公司", contractTitle: "合成机电分包合同", demand: "于收到本函后十日内核对并支付已到期款项", plannedDate: "2026-11-01", method: "专人递送", address: "合成测试地址" }
function paymentResult(): ReviewResult {
  const extraction = paymentExtraction(), calculation = calculateDocumentAmounts(extraction, "2026-10-31", true)
  return { schemaVersion: 1, reviewId: "test", createdAt: "2026-10-28T00:00:00Z", status: "success", mode: "debug", warnings: [], errors: [],
    input: { textSha256: "synthetic", documentVersionId: "version", parseSnapshotId: "snapshot", complete: true, context: {} }, callsUsed: 2, documentTitle: "合成资料", packVersion: "test",
    paragraphs: [{ index: 0, text: extraction.amounts[0].source.quote, inTable: false }], findings: [], rejected: [], notLocated: [], coverage: [], usage: null, model: "synthetic",
    documentAnalysis: { version: "document-agent-v1", task: "payment-reconciliation", cutoff: "2026-10-31", skill: { id: "test", version: "1", sha256: "synthetic" }, extraction,
      rejected: [], audit: { complete: true, checks: extractionIds(extraction).map(id => ({ id, accepted: true, reason: "合成核对" })), gaps: [] }, ...calculation, reviewStatus: "待人工复核" } }
}
test("AC-05/20: letter uses saved positive calculation and confirmed plans, never a contract face value", () => {
  const source = paymentResult(), letter = buildCollectionLetter({ plan, title: "上传文件名", cutoff: "2026-10-31", payment: source })
  assert.deepEqual(letter.missing, []); assert.match(letter.paragraphs.join(""), /500000\.00 元/); assert.match(letter.paragraphs.join(""), /尚未发送/)
  assert.doesNotMatch(letter.paragraphs.join(""), /上传文件名|已送达|违约金|利息/)
  source.documentAnalysis!.calculation!.unpaidFen = "1"
  assert.equal(usablePayment(source), null)
  assert.ok(buildCollectionLetter({ plan, title: "x", cutoff: "2026-10-31", payment: source }).missing.includes("已到期未付金额及有效款项依据"))
})
test("AC-05/19: missing facts, different parties and nonpositive claims remain marked drafts", () => {
  for (const changed of [{ ...plan, sender: "另一公司" }, { ...plan, recipient: "" }]) {
    const letter = buildCollectionLetter({ plan: changed, title: "x", cutoff: "2026-10-31", payment: paymentResult() })
    assert.match(letter.paragraphs.join(""), /待补充/); assert.doesNotMatch(letter.paragraphs.join(""), /500000\.00 元/)
  }
  const noSource = buildCollectionLetter({ plan, title: "x", cutoff: "2026-10-31" })
  assert.match(noSource.paragraphs.join(""), /待补充：已到期未付金额/)
  for (const demand of ["支付100万元", "支付利息", "汇入账号123456"]) assert.equal(letterPlanSchema.safeParse({ ...plan, demand }).success, false)
})
test("AC-11/22: audited draft exports a real validated DOCX and escapes XML without changing paragraphs", async () => {
  const letter = buildCollectionLetter({ plan: { ...plan, contractTitle: "合成合同<&>" }, title: "x", cutoff: "2026-10-31" })
  await assert.rejects(renderCollectionLetter(letter, AbortSignal.timeout(20000)))
  letter.auditPassed = true
  const bytes = await renderCollectionLetter(letter, AbortSignal.timeout(20000))
  assert.equal(bytes.subarray(0, 2).toString(), "PK")
})
