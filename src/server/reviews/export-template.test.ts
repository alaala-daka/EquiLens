import assert from "node:assert/strict"
import { test } from "node:test"
import { contractReviewReportTemplate, contractReviewReportTemplateV2 } from "./export-template"
import { successResult, validRunnerInput } from "./test-fixtures"

test("B2b: v2 keeps the machine report and appends indexed human decisions; v1 stays unchanged", () => {
  const value = successResult(validRunnerInput())
  const original = contractReviewReportTemplate.paragraphs(value)
  const revised = { ...value, findingDecisions: [{ findingIndex: 0, ruleId: value.findings[0].ruleId, decision: "修订", reason: "付款期限需明确", editedSuggestion: "收到计量确认后支付", editedImpact: "明确到期条件" }] }
  const lines = contractReviewReportTemplateV2.paragraphs(revised)
  assert.equal(contractReviewReportTemplate.version, "contract-review-report-v1")
  assert.equal(contractReviewReportTemplateV2.version, "contract-review-report-v2")
  assert.deepEqual(lines.slice(0, original.length), original)
  assert.deepEqual(contractReviewReportTemplate.paragraphs(revised), original)
  assert.match(lines.join("\n"), /处理理由：付款期限需明确/)
  assert.match(lines.join("\n"), /人工修订建议：收到计量确认后支付/)
  assert.match(lines.join("\n"), /人工修订影响：明确到期条件/)
  assert.match(contractReviewReportTemplateV2.paragraphs(value).join("\n"), /未处理/)
})
