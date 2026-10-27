import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ContractReviewReport } from "../../../src/components/contract-review-report"
import type { ReviewResult } from "../src/types"
import { revisionFixture } from "./revision-fixture"

test("revision report shows original findings even while the revised contract is incomplete", async () => {
  const { primary, draft } = await revisionFixture()
  const first = primary.findings[0]
  first.risk = "合成风险：付款期限不清。"
  first.suggestion = "明确付款期限。"
  const result = { ...primary, collaboration: { version: "multi-agent-revision-v1", primary, revision: { ...draft, status: "partial" }, phase: "revising" } } as ReviewResult
  const html = renderToStaticMarkup(createElement(ContractReviewReport, { result }))
  assert.match(html, /合成风险：付款期限不清/)
  assert.match(html, /明确付款期限/)
  assert.doesNotMatch(html, /查看原合同审查记录/)
})

test("revision report labels an audit finding as a problem rather than awaiting review", async () => {
  const { primary, draft, audit } = await revisionFixture()
  audit.checks[0].outcome = "存在问题"
  audit.checks[0].note = "合成复核发现冲突。"
  const result = { ...primary, collaboration: { version: "multi-agent-revision-v1", primary, revision: draft, revisionAudit: audit, phase: "completed" } } as ReviewResult
  const html = renderToStaticMarkup(createElement(ContractReviewReport, { result }))
  assert.match(html, /核对发现问题/)
  assert.match(html, /合成复核发现冲突/)
})
