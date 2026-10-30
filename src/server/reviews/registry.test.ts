import assert from "node:assert/strict"
import { test } from "node:test"
import { contractReviewResultValidator } from "./registry"
import { failedResult, invalidCitationResult, partialResult, successResult, validRunnerInput } from "./test-fixtures"

test("A4c validator: a complete debug-mode machine result is valid", async () => {
  const checked = await contractReviewResultValidator(successResult(validRunnerInput()))
  assert.equal(checked.status, "valid")
  assert.deepEqual(checked.issues, [])
})

test("B2b: decisions match a unique saved finding and require bounded reasons/revisions", async () => {
  const value = successResult(validRunnerInput())
  const decision = { findingIndex: 0, ruleId: value.findings[0].ruleId, decision: "修订", reason: "按项目付款条件调整", editedSuggestion: "补充明确付款期限", editedImpact: "明确履行期限" }
  for (const item of [decision, { ...decision, decision: "采纳", editedSuggestion: undefined }, { ...decision, decision: "驳回", editedSuggestion: undefined }]) {
    assert.equal((await contractReviewResultValidator({ ...value, findingDecisions: [item] })).status, "valid")
  }
  for (const decisions of [null, [decision, decision], [{ ...decision, findingIndex: 1 }], [{ ...decision, ruleId: "other" }], [{ ...decision, decision: "approved" }], [{ ...decision, reason: " " }], [{ ...decision, reason: "字".repeat(501) }], [{ ...decision, editedSuggestion: "" }], [{ ...decision, editedSuggestion: "字".repeat(2001) }], [{ ...decision, editedImpact: "字".repeat(501) }], [{ ...decision, decision: "采纳" }], [{ ...decision, quote: "改写" }]]) {
    const checked = await contractReviewResultValidator({ ...value, findingDecisions: decisions })
    assert.equal(checked.status, "invalid", JSON.stringify(decisions))
    assert.ok(checked.issues.some(issue => issue.code === "INVALID_DECISION"))
  }
  assert.equal((await contractReviewResultValidator({ ...value, findingDecisions: [] })).status, "valid")
})

test("B2b: adopting an invalid finding cannot waive citation validation", async () => {
  const value = invalidCitationResult(validRunnerInput())
  const checked = await contractReviewResultValidator({ ...value, findingDecisions: [{ findingIndex: 0, ruleId: value.findings[0].ruleId, decision: "采纳", reason: "确认" }] })
  assert.equal(checked.status, "invalid")
  assert.ok(checked.issues.some(issue => issue.code === "INVALID_CITATION"))
})

test("A4c validator: partial coverage stays saved but is reported as partial, never valid/no-risk", async () => {
  const checked = await contractReviewResultValidator(partialResult(validRunnerInput()))
  assert.equal(checked.status, "partial")
  assert.deepEqual(checked.issues, [])
})

test("A4c validator: published-mode and structurally tampered results are invalid", async () => {
  const value = successResult(validRunnerInput())
  const published = await contractReviewResultValidator({ ...value, mode: "published" })
  assert.equal(published.status, "invalid")
  assert.ok(published.issues.some(issue => issue.code === "UNSIGNED_BASIS"))
  const version = await contractReviewResultValidator({ ...value, schemaVersion: 2 })
  assert.equal(version.status, "invalid")
  const missingInput = await contractReviewResultValidator({ ...value, input: undefined })
  assert.equal(missingInput.status, "invalid")
})

test("C6 validator: mode published with the executor-embedded fixed refs is valid", async () => {
  const value = successResult(validRunnerInput())
  const ruleRef = { id: "publication-rule-pack-1", versionId: "publication-version-1", sha256: "a".repeat(64) }
  const checked = await contractReviewResultValidator({
    ...value, mode: "published", publicationBasis: { rules: [ruleRef], knowledge: [] },
  })
  assert.equal(checked.status, "valid")
  assert.deepEqual(checked.issues, [])
})

test("C6 validator: a bare or malformed published basis stays invalid", async () => {
  const value = successResult(validRunnerInput())
  const ruleRef = { id: "publication-rule-pack-1", versionId: "publication-version-1", sha256: "a".repeat(64) }
  const emptyRules = await contractReviewResultValidator({
    ...value, mode: "published", publicationBasis: { rules: [], knowledge: [] },
  })
  assert.equal(emptyRules.status, "invalid")
  assert.ok(emptyRules.issues.some(issue => issue.code === "UNSIGNED_BASIS"))
  const badSha = await contractReviewResultValidator({
    ...value, mode: "published", publicationBasis: { rules: [{ ...ruleRef, sha256: "not-a-digest" }], knowledge: [] },
  })
  assert.equal(badSha.status, "invalid")
  assert.ok(badSha.issues.some(issue => issue.code === "INVALID_STRUCTURE"))
  const duplicate = await contractReviewResultValidator({
    ...value, mode: "published", publicationBasis: { rules: [ruleRef, ruleRef], knowledge: [] },
  })
  assert.equal(duplicate.status, "invalid")
  const badKnowledge = await contractReviewResultValidator({
    ...value, mode: "published", publicationBasis: { rules: [ruleRef], knowledge: [{ id: "", versionId: "", sha256: "0".repeat(64) }] },
  })
  assert.equal(badKnowledge.status, "invalid")
})

test("C6 validator: debug results must not embed a published basis", async () => {
  const value = successResult(validRunnerInput())
  const checked = await contractReviewResultValidator({
    ...value, publicationBasis: { rules: [{ id: "publication-1", versionId: "version-1", sha256: "b".repeat(64) }], knowledge: [] },
  })
  assert.equal(checked.status, "invalid")
  assert.ok(checked.issues.some(issue => issue.code === "UNSIGNED_BASIS"))
})

test("A4c validator: the input text digest is rebuilt from the saved paragraphs", async () => {
  const value = successResult(validRunnerInput())
  const tampered = await contractReviewResultValidator({ ...value, input: { ...value.input, textSha256: "0".repeat(64) } })
  assert.equal(tampered.status, "invalid")
  assert.ok(tampered.issues.some(issue => issue.code === "INVALID_TEXT_HASH"))
  const editedParagraphs = await contractReviewResultValidator({
    ...value,
    paragraphs: value.paragraphs.map(paragraph => paragraph.index === 0 ? { ...paragraph, text: "被篡改的正文段落" } : paragraph),
  })
  assert.equal(editedParagraphs.status, "invalid")
})

test("A4c validator: every finding quote must be verbatim in the declared paragraph", async () => {
  const checked = await contractReviewResultValidator(invalidCitationResult(validRunnerInput()))
  assert.equal(checked.status, "invalid")
  assert.ok(checked.issues.some(issue => issue.code === "INVALID_CITATION"))
  const value = successResult(validRunnerInput())
  const citation = { ...value.findings[0].citations![0], paragraphIndex: 1 }
  const mismatched = await contractReviewResultValidator({
    ...value,
    findings: [{ ...value.findings[0], citations: [citation] }],
  })
  assert.equal(mismatched.status, "invalid")
  assert.ok(mismatched.issues.some(issue => issue.code === "INVALID_CITATION"))
})

test("A4c validator: success must not be claimed with incomplete input, open coverage or errors", async () => {
  const value = successResult(validRunnerInput())
  const incomplete = await contractReviewResultValidator({ ...value, input: { ...value.input, complete: false } })
  assert.equal(incomplete.status, "invalid")
  assert.ok(incomplete.issues.some(issue => issue.code === "COVERAGE_INCONSISTENT"))
  const pendingCoverage = { ...value, coverage: value.coverage.map((item, index) => index === 0 ? { ...item, status: "待核实" as const } : item) }
  const openCoverage = await contractReviewResultValidator(pendingCoverage)
  assert.equal(openCoverage.status, "invalid")
  assert.ok(openCoverage.issues.some(issue => issue.code === "COVERAGE_INCONSISTENT"))
  const withError = { ...value, errors: [{ code: "AI_TIMEOUT", message: "模型请求超时。", ruleIds: [] }] }
  const errorClaim = await contractReviewResultValidator(withError)
  assert.equal(errorClaim.status, "invalid")
  const failed = await contractReviewResultValidator(failedResult(validRunnerInput()))
  assert.equal(failed.status, "invalid")
  assert.ok(failed.issues.some(issue => issue.code === "RESULT_FAILED"))
})

test("A4c validator: coverage must contain all six required categories and a partial needs a definite conclusion", async () => {
  const value = successResult(validRunnerInput())
  const missingCategory = await contractReviewResultValidator({ ...value, coverage: value.coverage.slice(0, 5) })
  assert.equal(missingCategory.status, "invalid")
  assert.ok(missingCategory.issues.some(issue => issue.code === "INVALID_STRUCTURE"))
  const placeholdersOnly = partialResult(validRunnerInput())
  const checked = await contractReviewResultValidator({ ...placeholdersOnly, findings: placeholdersOnly.findings.filter(finding => finding.placeholder === true) })
  assert.equal(checked.status, "invalid")
  assert.ok(checked.issues.some(issue => issue.code === "COVERAGE_INCONSISTENT"))
})
