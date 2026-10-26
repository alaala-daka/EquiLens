import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { bundleDigest, type SceneBundle } from "../../../../tools/contract-review/src/bundles"
import { sceneCatalog } from "../../../../tools/contract-review/src/scenes"
import { testPack } from "../../../../tools/contract-review/tests/helpers"
import type { RuleEntry } from "../../../../tools/contract-review/src/types"
import type { ReviewSkill } from "../../../../tools/contract-review/src/agent/skill"
import { runClaimedReview } from "./workflow"
import { setup } from "./test-fixtures"

const TEXT = "合成办公楼机电安装专业分包合同，约定付款条件与结算方式。"
const sceneId = "mep-sub-2026"

/** 只装配机电安装一个场景包：合成规则绑定真实登记的场景标识。 */
function mepBundle(): { bundle: SceneBundle; rules: RuleEntry[] } {
  const pack = testPack()
  pack.rules.forEach(rule => { rule.appliesTo = { scene: sceneId, role: "专业分包人" } })
  const candidate = sceneCatalog().find(item => item.id === sceneId)!
  const skill: ReviewSkill = { id: "contract-review", name: "合成", description: "合成测试", version: "test", instructions: "仅合成测试", sha256: "2".repeat(64) }
  const value = { candidate, pack, skill }
  return { bundle: { ...value, sha256: bundleDigest(value) }, rules: pack.rules }
}

type Mode = "substantive" | "no-check"
/** 按工具菜单区分三个角色；no-check 模拟"只加载技能就提交待核实、未读正文"。 */
function transport(rules: RuleEntry[], mode: Mode) {
  const roles: string[] = []
  let primaryStep = 0, batch = 0
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const menu = (body.tools as { function: { name: string } }[]).map(item => item.function.name)
    let name: string, input: unknown
    if (menu.length === 1 && menu[0] === "selectScene") {
      roles.push("router")
      name = "selectScene"
      input = { status: "matched", sceneId, reason: "合成测试指定场景。", evidence: [{ paragraphIndex: 0, quote: TEXT }], missingInfo: [] }
    } else if (menu.length === 1 && menu[0] === "submitAudit") {
      roles.push("auditor")
      const target = JSON.parse(String(body.messages.at(-1).content)).targetRuleIds as string[]
      name = "submitAudit"
      input = { checks: target.map(ruleId => ({
        ruleId, outcome: "保留", issueTypes: [], note: "合成核对，仍待人工复核。", paragraphIndex: 0, quote: TEXT, basis: ["S-1"],
      })) }
    } else {
      roles.push("primary")
      primaryStep += 1
      if (primaryStep === 1) { name = "loadSkill"; input = { skillId: "contract-review" } }
      else if (mode === "no-check") {
        name = "submitFindings"
        input = { findings: rules.slice(batch * 3, batch * 3 + 3).map(rule => ({
          ruleId: rule.ruleId, kind: "待核实", risk: "合成待核实。", severity: rule.severity,
          quote: "", paragraphIndex: -1, basis: [], impact: "", suggestion: "补充材料。", pending: ["合成待核实事项。"],
        })) }
        batch += 1
      } else if (primaryStep === 2) { name = "readParagraphs"; input = { indexes: [0] } }
      else if (primaryStep === 3) { name = "readSources"; input = { sourceIds: ["S-1"] } }
      else {
        name = "submitFindings"
        input = { findings: rules.slice(batch * 3, batch * 3 + 3).map(rule => ({
          ruleId: rule.ruleId, kind: "发现问题", risk: "合成检查发现问题。", severity: rule.severity,
          quote: TEXT, paragraphIndex: 0, basis: ["S-1"], impact: "", suggestion: "核对合成字段。", pending: [],
        })) }
        batch += 1
      }
    }
    return Response.json({ id: `multi-${roles.length}`, object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: `call-${roles.length}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  return { fetcher, roles }
}

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }

async function claimedMultiAgentJob(text = TEXT) {
  const s = await setup()
  const { bundle, rules } = mepBundle()
  const input = structuredClone(s.input)
  input.workflow = "multi-agent-v1"
  input.sceneBundles = [bundle]
  input.auditEffort = "default"
  input.pack = bundle.pack
  input.skill = bundle.skill
  const task = await s.repository.create(s.owner, randomUUID(), s.request, input, 25, 7)
  const job = (await s.repository.claim())!
  assert.equal(job.id, task.id)
  const paragraphs = text ? [{ index: 0, text, inTable: false }] : []
  const snapshot = { id: randomUUID(), paragraphs, complete: true, textSha256: createHash("sha256").update(text).digest("hex") }
  await s.repository.snapshot(job, snapshot)
  job.snapshot = snapshot
  return { s, job, rules, bundle }
}

test("AC-21/23: multi-agent task runs router, primary and auditor through the real runner", async () => {
  const { s, job, rules } = await claimedMultiAgentJob()
  try {
    const state = transport(rules, "substantive")
    await runClaimedReview(job, { repository: s.repository, env, fetcher: state.fetcher })
    const rows = (await s.database.transaction(c => c.query("SELECT state, stage, calls_used, result, error_code FROM equilens_review_tasks WHERE id=$1", [job.id]))).rows
    assert.equal(rows.length, 1)
    assert.equal(String(rows[0].state), "success")
    assert.equal(String(rows[0].stage), "completed")
    assert.equal(rows[0].error_code, null)
    assert.equal(Number(rows[0].calls_used), state.roles.length)
    assert.deepEqual(state.roles, ["router", ...Array(5).fill("primary"), "auditor", "auditor"])
    const saved = JSON.parse(String(rows[0].result))
    assert.equal(saved.collaboration.primaryCompleted, true)
    assert.equal(saved.collaboration.phase, "completed")
    assert.equal(saved.sceneSelection.status, "matched")
    assert.equal(saved.collaboration.audit.status, "completed")
    assert.equal(saved.collaboration.audit.checks.length, rules.length)
    const stored = (await s.database.transaction(c => c.query("SELECT stage, payload FROM equilens_review_artifacts WHERE task_id=$1 AND stage='model-exchange'", [job.id]))).rows
    const roles = new Set(stored.map(row => JSON.parse(String(row.payload)).agentRole))
    assert.deepEqual([...roles].sort(), ["auditor", "primary", "router"])
  } finally { await s.close() }
})

test("AC-03/21/23: a primary without any checked range cannot seal, skip recovery or reach audit", async () => {
  const { s, job, rules } = await claimedMultiAgentJob()
  try {
    const state = transport(rules, "no-check")
    await runClaimedReview(job, { repository: s.repository, env, fetcher: state.fetcher })
    assert.deepEqual(state.roles, ["router", "primary", "primary", "primary"])
    const rows = (await s.database.transaction(c => c.query("SELECT state, calls_used, result, error_code FROM equilens_review_tasks WHERE id=$1", [job.id]))).rows
    assert.equal(String(rows[0].state), "failed")
    assert.equal(String(rows[0].error_code), "REVIEW_PRIMARY_INCOMPLETE")
    assert.equal(Number(rows[0].calls_used), state.roles.length)
    const saved = JSON.parse(String(rows[0].result))
    assert.equal(saved.status, "failed")
    assert.equal(saved.collaboration.primaryCompleted, false)
    assert.equal(saved.collaboration.audit, undefined)
    assert.ok(saved.findings.every((item: { checkedParagraphIndexes?: number[] }) => !item.checkedParagraphIndexes?.length))
  } finally { await s.close() }
})

test("AC-03/23: an empty document fails before any model request", async () => {
  const { s, job, rules } = await claimedMultiAgentJob("")
  try {
    const state = transport(rules, "substantive")
    await runClaimedReview(job, { repository: s.repository, env, fetcher: state.fetcher })
    assert.deepEqual(state.roles, [])
    const rows = (await s.database.transaction(c => c.query("SELECT state, calls_used, error_code FROM equilens_review_tasks WHERE id=$1", [job.id]))).rows
    assert.equal(String(rows[0].state), "failed")
    assert.equal(String(rows[0].error_code), "REVIEW_INPUT_EMPTY")
    assert.equal(Number(rows[0].calls_used), 0)
  } finally { await s.close() }
})
