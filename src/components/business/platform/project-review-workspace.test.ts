import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProjectResultView } from "../../../lib/business/reviews-client"
import type { FindingDecision } from "../../../lib/business/contracts"
import { successResult, validRunnerInput } from "../../../server/reviews/test-fixtures"
import { reviewRevisionIssues, reviewRevisionValue, sameFindingDecisions, updateReviewRevisionDraft } from "./review-draft"
import { ReviewResultPanel } from "./review-result-panel"

const value = successResult(validRunnerInput())
const result: ProjectResultView = {
  projectId: "project", resultId: "result", versionId: "version-1", sha256: "a".repeat(64), kind: "contract-review",
  value, machineOutput: value, origin: "machine", sources: [], dependencies: [], provenance: null,
  validation: { status: "valid", versionId: "version-1", checkedAt: "2026-10-30T00:00:00Z", issues: [] },
  review: null, createdAt: "2026-10-30T00:00:00Z", createdBy: "author", reason: "",
}
const decision: FindingDecision = { findingIndex: 0, ruleId: value.findings[0].ruleId, decision: "修订", reason: "明确付款期限", editedSuggestion: "计量确认后支付" }

test("B2b: revision draft remains bound to its original version after a refresh/conflict", () => {
  const draft = updateReviewRevisionDraft(undefined, result, [decision], "核对付款条件", "operation-1")!
  const newer = { ...result, versionId: "version-2", sha256: "b".repeat(64) }
  const edited = updateReviewRevisionDraft(draft, newer, [{ ...decision, reason: "补充说明" }], draft.reason, "operation-2")!
  assert.equal(edited.base.versionId, "version-1")
  assert.equal(edited.base.sha256, result.sha256)
  assert.equal(edited.operationId, "operation-2")
  assert.deepEqual(reviewRevisionValue(edited), { ...value, findingDecisions: edited.decisions })
  assert.deepEqual(result.value, value)
  assert.deepEqual(reviewRevisionIssues(edited), [])
  assert.equal(updateReviewRevisionDraft(edited, newer, [], "", "operation-3"), null)
})

test("B2b: incomplete decisions require reasons and revised suggestions before save", () => {
  const draft = updateReviewRevisionDraft(undefined, result, [{ ...decision, reason: "", editedSuggestion: "" }], "", "operation-1")!
  assert.equal(reviewRevisionIssues(draft).length, 3)
})

test("B2b: decision equality ignores JSON key order and clearing a saved decision remains a revision", () => {
  const canonical = { decision: decision.decision, editedSuggestion: decision.editedSuggestion, findingIndex: decision.findingIndex, reason: decision.reason, ruleId: decision.ruleId }
  assert.equal(sameFindingDecisions([canonical], [decision]), true)
  const saved = { ...result, value: { ...value, findingDecisions: [canonical] } }
  const cleared = updateReviewRevisionDraft(undefined, saved, [], "撤销原处理", "operation-1")!
  assert.ok(cleared)
  assert.deepEqual(reviewRevisionIssues(cleared), [])
  assert.deepEqual(reviewRevisionValue(cleared).findingDecisions, [])
})

function panel(canEdit: boolean, dirty = false) {
  return renderToStaticMarkup(createElement(ReviewResultPanel, {
    result: { ...result, value: { ...value, findingDecisions: [decision] } }, value,
    validation: result.validation, exports: [], exportsError: "", canEdit, busy: null, error: "",
    revision: dirty ? updateReviewRevisionDraft(undefined, result, [decision], "确认", "operation-1")! : undefined,
    onEditRevision() {}, onSaveRevision() {}, onDiscardRevision() {}, onValidate() {}, onReview() {}, onCreateExport() {}, onDownloadExport() {},
  }))
}

test("B2b: editors see the finding controls; viewers see saved decisions without write controls", () => {
  const editor = panel(true, true)
  assert.match(editor, /保存修订版本/)
  assert.match(editor, /<select/)
  assert.match(editor, /修订建议/)
  assert.match(editor, /disabled=""[^>]*>导出 Word/)
  const viewer = panel(false)
  assert.match(viewer, /处理决定：修订/)
  assert.match(viewer, /计量确认后支付/)
  assert.doesNotMatch(viewer, /<select|保存修订版本/)
})
