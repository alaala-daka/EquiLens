import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { auditReview, type AuditCheck } from "./agent/audit"
import { reviewWithAgent, type AgentSettings } from "./agent/run"
import { parseDocument, paragraphsFromString } from "./document"
import { ReviewError, safeError } from "./errors"
import { prepareReviewInput } from "./input"
import { loadRulePack } from "./pack"
import { toMarkdown } from "./report"
import { defaultSceneId, sceneContext } from "./scenes"
import type { FindingKind, ReviewResult } from "./types"
import { buildCoverage, validateFindings } from "./validate"

const plain = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}<>|]/g, "\\$&")
const digest = (text: string) => createHash("sha256").update(text).digest("hex")

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--")
  const options: { contract?: string; output: string; debug: boolean; challenge: boolean; auditEffort: "default" | "low" } = {
    output: "tools/contract-review/output", debug: false, challenge: false, auditEffort: "default",
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--debug") options.debug = true
    else if (args[i] === "--challenge") options.challenge = true
    else if (["--contract", "--out", "--audit-effort"].includes(args[i])) {
      const flag = args[i], value = args[++i]
      if (!value || value.startsWith("--")) throw new ReviewError("REVIEW_INPUT_INVALID")
      if (flag === "--audit-effort") {
        if (value !== "low" && value !== "default") throw new ReviewError("REVIEW_INPUT_INVALID")
        options.auditEffort = value
      } else if (flag === "--contract") options.contract = value
      else options.output = value
    } else throw new ReviewError("REVIEW_INPUT_INVALID")
  }
  if ((!options.contract && !options.challenge) || (options.challenge && options.contract)) throw new ReviewError("REVIEW_INPUT_INVALID")
  try { process.loadEnvFile(".env.local") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const maxCalls = Number(process.env.AI_AGENT_MAX_CALLS ?? 25)
  const maxPromptChars = Number(process.env.AI_REVIEW_MAX_PROMPT_CHARS ?? (options.debug ? 240000 : NaN))
  if (!Number.isSafeInteger(maxPromptChars)) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const pack = await loadRulePack(resolve("tools/contract-review/rules"))
  const mode = options.debug ? "debug" as const : "published" as const
  const directory = resolve(options.output, `comparison-${randomUUID()}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  async function write(name: string, data: unknown) {
    const file = await open(resolve(directory, name), "wx", 0o600)
    try { await file.writeFile(typeof data === "string" ? data : JSON.stringify(data, null, 2)); await file.sync() } finally { await file.close() }
  }
  function hooks(role: string): Pick<AgentSettings, "onBeforeCall" | "onModelExchange"> {
    return {
      onBeforeCall: async reservation => {
        await write(`${role}-${reservation.callNumber}.reservation.json`, { ...reservation, role, at: new Date().toISOString() })
        console.log(JSON.stringify({ role, call: reservation.callNumber }))
      },
      onModelExchange: async exchange => { await write(`${role}-${exchange.callNumber}.exchange.json`, exchange) },
    }
  }
  if (options.challenge) {
    const fixture = JSON.parse(await readFile(resolve("tools/contract-review/fixtures/audit-challenges.json"), "utf8")) as {
      documentText: string; ruleId: string; paragraphIndex: number
      cases: { id: string; kind: FindingKind; risk: string; suggestion: string; expectedOutcome: string; expectedIssueType: AuditCheck["issueTypes"][number] | null }[]
    }
    const paragraphs = paragraphsFromString(fixture.documentText)
    const rule = pack.rules.find(rule => rule.ruleId === fixture.ruleId)!
    await write("expectations.json", fixture)
    const observations = []
    for (const item of fixture.cases) {
      const prepared = prepareReviewInput({ paragraphs, context: sceneContext(defaultSceneId, "上海"), mode }, pack, process.env.AI_MODEL ?? "")
      const raw = { ruleId: rule.ruleId, kind: item.kind, risk: item.risk, suggestion: item.suggestion,
        severity: rule.severity, quote: paragraphs[fixture.paragraphIndex].text, paragraphIndex: fixture.paragraphIndex,
        basis: rule.basis.map(basis => basis.sourceId), impact: "合成文本忠实度检查。", pending: [] }
      const checked = validateFindings([raw], [{ rule, excerpts: [] }], paragraphs, new Set(pack.sources.map(source => source.sourceId)), true)
      if (checked.findings.length !== 1) throw new ReviewError("REVIEW_OUTPUT_INVALID")
      prepared.result.findings = checked.findings
      prepared.result.coverage = buildCoverage(checked.findings, [{ rule, excerpts: [] }])
      prepared.result.status = "partial"
      await write(`${item.id}.primary.json`, prepared.result)
      const audit = await auditReview({ primary: prepared.result, pack, maxCalls: Math.min(maxCalls, 3), maxPromptChars,
        reasoningEffort: options.auditEffort, ...hooks(item.id) })
      await write(`${item.id}.audit.json`, audit)
      observations.push({ caseId: item.id, expectedOutcome: item.expectedOutcome, observedOutcome: audit.checks[0]?.outcome ?? "未完成",
        matched: audit.checks[0]?.outcome === item.expectedOutcome && (!item.expectedIssueType || audit.checks[0].issueTypes.includes(item.expectedIssueType)),
        checks: audit.checks, errors: audit.errors, callsUsed: audit.callsUsed, usage: audit.usage, elapsedMs: audit.elapsedMs })
    }
    await write("challenge-observations.json", observations)
    console.log(JSON.stringify({ directory, challenge: true, observations }))
    process.exitCode = observations.every(item => item.matched) ? 0 : 2
    return
  }
  const parsed = await parseDocument(resolve(options.contract!))
  await write("manifest.json", { inputSha256: digest(parsed.paragraphs.map(p => p.text).join("\n")),
    packSha256: digest(JSON.stringify(pack)), model: process.env.AI_MODEL, mode, maxCalls, auditEffort: options.auditEffort, totalTimeoutMs: 600000,
    comparison: "same-primary-plus-independent-audit", startedAt: new Date().toISOString() })
  const controller = new AbortController(), start = Date.now()
  const deadline = setTimeout(() => controller.abort(new ReviewError("REVIEW_TIMEOUT")), 600000)
  let primary: ReviewResult
  try {
    primary = await reviewWithAgent({ pack, paragraphs: parsed.paragraphs, complete: parsed.complete,
      documentTitle: basename(options.contract!), context: sceneContext(defaultSceneId, "上海"), mode,
      maxCalls, maxPromptChars, signal: controller.signal, ...hooks("primary") })
    const primaryElapsedMs = Date.now() - start
    await write("primary.json", primary)
    await write("primary.md", toMarkdown(primary))
    const audit = await auditReview({ primary, pack, maxCalls, maxPromptChars, signal: controller.signal, reasoningEffort: options.auditEffort,
      timeoutMs: Math.max(1, 600000 - primaryElapsedMs), ...hooks("audit") })
    await write("audit.json", audit)
    const metrics = { primary: { status: primary.status, calls: primary.callsUsed, elapsedMs: primaryElapsedMs, usage: primary.usage,
      rejected: primary.rejected.length, pending: primary.findings.filter(item => item.kind === "待核实").length },
      withAudit: { auditStatus: audit.status, calls: audit.callsUsed, elapsedMs: Date.now() - start,
        totalKnownTokens: (primary.usage?.totalTokens ?? 0) + (audit.usage?.totalTokens ?? 0),
        flagged: audit.checks.filter(check => check.outcome === "需人工核对").length, reviewed: audit.checks.length,
        unreviewed: audit.unreviewedRuleIds, rejectedAudit: audit.rejected.length },
      primaryUnchanged: digest(JSON.stringify(primary)) === audit.primarySha256,
      legalAccuracyEvaluated: false }
    await write("comparison.json", metrics)
    const lines = ["# 单 Agent 与追加独立复核对照", "", "同一次主审输出，复核只增加机器核对意见；全部仍待人工复核。", "",
      "| 指标 | 仅主审 | 主审＋复核 |", "| --- | --- | --- |",
      `| 调用预算占用 | ${primary.callsUsed} | ${audit.callsUsed} |`,
      `| 耗时 ms | ${primaryElapsedMs} | ${metrics.withAudit.elapsedMs} |`,
      `| 已知 token | ${primary.usage?.totalTokens ?? "未返回"} | ${metrics.withAudit.totalKnownTokens} |`,
      `| 待人工核对意见 | — | ${metrics.withAudit.flagged} |`, "", "## 核对意见", ""]
    for (const check of audit.checks) lines.push(`- ${plain(check.ruleId)} · ${check.outcome}：${plain(check.note)}`)
    lines.push("", "未完成核对：" + (audit.unreviewedRuleIds.join("、") || "无"), "", "未评估法律准确率，不能据此判断漏检或误报改善。", "")
    await write("comparison.md", lines.join("\n"))
    console.log(JSON.stringify({ directory, ...metrics }))
    process.exitCode = audit.status === "completed" && primary.status !== "failed" && !primary.errors.length ? 0 : 2
  } finally { clearTimeout(deadline) }
}
main().catch(failure => { console.error(JSON.stringify(safeError(failure))); process.exitCode = 1 })
