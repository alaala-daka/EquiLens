import assert from "node:assert/strict"
import { test } from "node:test"
import { ReviewSession } from "../src/agent/session"
import { testPack } from "./helpers"

function session() {
  return new ReviewSession({ documentText: "付款条款。\n另一条款。", complete: true }, testPack(), {
    id: "contract-review", name: "合成", description: "测试", version: "test", instructions: "仅测试", sha256: "synthetic",
  }, "synthetic", 0, 64000)
}
const answer = (ruleId: string, kind = "未发现问题") => ({ ruleId, kind, risk: "合成校验", severity: "一般关注", quote: "付款条款。", paragraphIndex: 0, basis: ["S-1"], impact: "", suggestion: "合成建议", pending: [] })

test("AC-03/21: agent rejects unread citations and cannot clear risk after only partial reading", () => {
  const s = session()
  s.loadSkill("contract-review")
  s.readParagraphs([0])
  s.readSources(["S-1"])
  assert.equal(s.submit([answer("T-001", "发现问题")]).acceptedRuleIds.length, 0)
  s.commitReads()
  assert.equal(s.submit([answer("T-001")]).acceptedRuleIds.length, 0)
  assert.equal(s.submit([answer("T-001", "发现问题")]).acceptedRuleIds.length, 1)
  const result = s.finish()
  assert.equal(result.status, "partial")
  assert.equal(result.summary?.unreadParagraphs, 1)
  assert.ok(result.findings.some(item => item.kind === "待核实"))
})

test("AC-09/23: restored findings keep their citations but new submissions must read again", () => {
  const first = session()
  first.loadSkill("contract-review")
  first.readParagraphs([0, 1]); first.readSources(["S-1"]); first.commitReads()
  assert.equal(first.submit([answer("T-001")]).acceptedRuleIds.length, 1)
  const second = session()
  second.restore(first.checkpoint())
  second.loadSkill("contract-review")
  assert.equal(second.checkCoverage().readParagraphCount, 0)
  assert.ok(!second.checkCoverage().unansweredRuleIds.includes("T-001"))
  assert.equal(second.submit([answer("T-002")]).acceptedRuleIds.length, 0)
  assert.equal(second.finish().status, "partial")
})

test("AC-21: contradictory advice remains rejected and unresolved in the Agent report", () => {
  const s = new ReviewSession({
    documentText: "10.1 争议提交合成仲裁委员会仲裁。\n10.2 双方可向人民法院起诉。", complete: true,
  }, testPack(), {
    id: "contract-review", name: "合成", description: "测试", version: "test", instructions: "仅测试", sha256: "synthetic",
  }, "synthetic", 0, 64000)
  s.loadSkill("contract-review")
  s.readParagraphs([0, 1]); s.readSources(["S-1"]); s.commitReads()
  const submission = s.submit([{ ...answer("T-001", "发现问题"), quote: "10.1 争议提交合成仲裁委员会仲裁。",
    suggestion: "删除 10.2，保留诉讼。" }])
  assert.equal(submission.acceptedRuleIds.length, 0)
  const result = s.finish()
  assert.equal(result.status, "failed")
  assert.ok(result.rejected.some(item => item.reason === "建议前后矛盾"))
  assert.ok(result.findings.every(item => item.kind === "待核实"))
})
