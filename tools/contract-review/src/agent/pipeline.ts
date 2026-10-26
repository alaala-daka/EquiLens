import { createHash } from "node:crypto"
import { prepareReviewInput, type ReviewInput } from "../input"
import { validateBundles, type SceneBundle } from "../bundles"
import { ReviewError, safeError } from "../errors"
import type { Collaboration, ReviewResult } from "../types"
import { reviewWithAgent, type AgentSettings } from "./run"
import { routeScene, validateRoute } from "./router"
import { auditReview } from "./audit"
import { abortable } from "./abort"
import { publishedRules } from "../pack"
import { DEFAULT_AGENT_CALLS, MAX_AGENT_CALLS } from "../limits"
import { hasCheckedRange } from "../findings"

export type MultiAgentOptions = ReviewInput & AgentSettings & {
  bundles: SceneBundle[]; env?: Record<string, string | undefined>; fetcher?: typeof fetch
  previousResult?: ReviewResult; auditEffort?: "default" | "low"
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function sumUsage(...values: ReviewResult["usage"][]): ReviewResult["usage"] {
  const known = values.filter(value => value !== null)
  return known.length ? known.reduce((sum, value) => ({ inputTokens: sum.inputTokens + value.inputTokens,
    outputTokens: sum.outputTokens + value.outputTokens, totalTokens: sum.totalTokens + value.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null
}

/** 三个独立模型上下文，共享一个任务、固定交接快照和累计外发预算。 */
export async function reviewWithAgents(options: MultiAgentOptions): Promise<ReviewResult> {
  const bundles = structuredClone(options.bundles)
  const env = options.env ? { ...options.env } : undefined
  const auditEffort = options.auditEffort ?? "default"
  validateBundles(bundles)
  const maxCalls = options.maxCalls ?? DEFAULT_AGENT_CALLS, timeoutMs = options.timeoutMs ?? 600000
  let callsUsed = options.callsUsed ?? 0
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_AGENT_CALLS || !Number.isSafeInteger(callsUsed) || callsUsed < 0 || callsUsed > maxCalls ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !["default", "low"].includes(auditEffort)) throw new ReviewError("REVIEW_INPUT_INVALID")
  for (const [value, minimum, maximum] of [[options.maxPromptChars ?? 240000, 1000, 240000],
    [options.requestTimeoutMs ?? 90000, 1, 90000], [options.maxToolChars ?? 16000, 1000, 64000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ReviewError("REVIEW_INPUT_INVALID")
  }
  const prepared = prepareReviewInput(options, bundles[0].pack, (env?.AI_MODEL ?? process.env.AI_MODEL)?.trim() || "glm-5.3-flash", callsUsed)
  if (bundles.some(bundle => bundle.pack.manifest.status === "已停用" ||
    (prepared.result.mode === "published" && !publishedRules(bundle.pack).length))) throw new ReviewError("REVIEW_RULES_UNAVAILABLE")
  const candidates = bundles.map(item => item.candidate)
  const manifestSha256 = hash({ version: "multi-agent-v1", bundles: bundles.map(item => item.sha256), auditEffort })
  const prior = options.previousResult ? structuredClone(options.previousResult) : undefined
  if (prior && (prior.collaboration?.manifestSha256 !== manifestSha256 || prior.input.textSha256 !== prepared.result.input.textSha256 ||
    prior.input.documentVersionId !== prepared.result.input.documentVersionId || prior.input.parseSnapshotId !== prepared.result.input.parseSnapshotId ||
    prior.callsUsed > callsUsed || prior.input.context.role !== prepared.context.role || prior.input.context.region !== prepared.context.region ||
    prior.model !== prepared.result.model)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const collaboration: Collaboration = prior?.collaboration ?? { version: "multi-agent-v1", manifestSha256, phase: "identifying", primaryCompleted: false }
  const start = Date.now(), controller = new AbortController(), signal = controller.signal
  const timeout = setTimeout(() => controller.abort(new ReviewError("REVIEW_TIMEOUT")), timeoutMs)
  const cancel = () => controller.abort(new ReviewError("REVIEW_CANCELLED"))
  options.signal?.addEventListener("abort", cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const failures: ReviewResult["errors"] = []
  const remainingTime = () => Math.max(1, timeoutMs - (Date.now() - start))
  const snapshot = (final = false): ReviewResult => {
    const base = structuredClone(collaboration.primary ?? prepared.result)
    base.collaboration = structuredClone(collaboration)
    base.sceneCandidates = structuredClone(candidates)
    base.sceneSelection = structuredClone(collaboration.routing?.selection)
    base.sceneSelectionReadParagraphIndexes = [...(collaboration.routing?.readParagraphIndexes ?? [])]
    base.callsUsed = callsUsed
    base.usage = sumUsage(collaboration.routing?.usage ?? null, collaboration.primary?.usage ?? null, collaboration.audit?.usage ?? null)
    base.errors.push(...(collaboration.routing?.errors ?? []).map(error => ({ ...error, ruleIds: [] })), ...failures)
    if (collaboration.audit?.errors.length) base.errors.push(...collaboration.audit.errors.map(error => ({ ...error, ruleIds: [] })))
    if (final && collaboration.primaryCompleted && collaboration.audit?.status !== "completed") base.errors.push({ code: "REVIEW_AUDIT_INCOMPLETE", message: new ReviewError("REVIEW_AUDIT_INCOMPLETE").message, ruleIds: [] })
    const valid = base.findings.some(hasCheckedRange)
    base.status = collaboration.primary?.status === "success" && collaboration.audit?.status === "completed" && !base.errors.length ? "success" : valid ? "partial" : "failed"
    return base
  }
  const publish = async () => {
    signal.throwIfAborted()
    try {
      const current = snapshot()
      await abortable(Promise.resolve(options.onProgress?.({ stage: collaboration.phase, reviewId: current.reviewId, callsUsed,
        agentRole: collaboration.phase === "identifying" ? "router" : collaboration.phase === "reviewing" ? "primary" : "auditor",
        readParagraphCount: collaboration.primary?.agent?.readParagraphIndexes.length ?? collaboration.routing?.readParagraphIndexes.length ?? 0,
        paragraphCount: prepared.paragraphs.length, submittedRuleCount: collaboration.primary?.findings.filter(item => item.checkedParagraphIndexes).length ?? 0,
        auditedRuleCount: collaboration.audit?.checks.length ?? 0,
      })), signal)
      await abortable(Promise.resolve(options.onCheckpoint?.(current)), signal)
    } catch {
      signal.throwIfAborted()
      controller.abort(new ReviewError("REVIEW_PROGRESS_FAILED")); throw signal.reason
    }
  }
  const reserve: NonNullable<AgentSettings["onBeforeCall"]> = async reservation => {
    signal.throwIfAborted()
    if (reservation.callNumber !== callsUsed + 1 || reservation.callNumber > maxCalls) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
    callsUsed = reservation.callNumber
    await abortable(Promise.resolve(options.onBeforeCall?.(reservation)), signal)
  }
  const exchange = async (role: "router" | "primary" | "auditor", value: { callNumber: number; request: unknown; response: unknown }) => {
    await abortable(Promise.resolve(options.onModelExchange?.({ ...value, agentRole: role })), signal)
  }
  try {
    await publish()
    if (!collaboration.routing?.selection) {
      collaboration.phase = "identifying"
      const oldUsage = collaboration.routing?.usage ?? null
      collaboration.routing = await routeScene({ paragraphs: prepared.paragraphs, candidates, context: prepared.context, complete: prepared.result.input.complete,
        env, fetcher: options.fetcher, signal, callsUsed, maxCalls: Math.min(4, maxCalls), timeoutMs: remainingTime(),
        requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars, onBeforeCall: reserve,
        onModelExchange: value => exchange("router", value),
        onCheckpoint: async value => { collaboration.routing = { ...value, usage: sumUsage(oldUsage, value.usage) }; await publish() },
      })
      collaboration.routing.usage = sumUsage(oldUsage, collaboration.routing.usage)
    }
    const routing = collaboration.routing
    if (!routing.selection || routing.errors.length) return snapshot(true)
    if (routing.inputSha256 !== prepared.result.input.textSha256 || routing.catalogSha256 !== hash(candidates)) throw new ReviewError("REVIEW_INPUT_INVALID")
    const selection = validateRoute(routing.selection, prepared.paragraphs, prepared.result.input.complete, prepared.context, candidates)
    if (selection.status !== "matched") {
      const code = selection.status === "unsupported" ? "REVIEW_SCENE_UNSUPPORTED" : "REVIEW_SCENE_UNCERTAIN"
      failures.push({ code, message: new ReviewError(code).message, ruleIds: [] })
      return snapshot(true)
    }
    const bundle = bundles.find(item => item.candidate.id === selection.sceneId)!
    const context = { ...prepared.context, scene: bundle.candidate.id, projectType: bundle.candidate.label }
    if (!collaboration.primaryCompleted) {
      collaboration.phase = "reviewing"
      await publish()
      const reserveForAudit = Math.ceil(bundle.pack.rules.filter(rule => rule.status !== "已停用").length / 3) + 1
      const primaryLimit = Math.max(1, maxCalls - reserveForAudit)
      if (callsUsed >= primaryLimit) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
      collaboration.primary = await reviewWithAgent({ paragraphs: prepared.paragraphs, complete: prepared.result.input.complete,
        documentTitle: prepared.result.documentTitle, documentVersionId: prepared.result.input.documentVersionId, parseSnapshotId: prepared.result.input.parseSnapshotId,
        context, mode: prepared.result.mode, pack: bundle.pack, skill: bundle.skill, env, fetcher: options.fetcher, signal,
        callsUsed, maxCalls: primaryLimit, timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs,
        maxPromptChars: options.maxPromptChars, maxToolChars: options.maxToolChars, previousResult: collaboration.primary,
        onBeforeCall: reserve, onModelExchange: value => exchange("primary", value),
        onCheckpoint: async value => { collaboration.primary = value; await publish() },
      })
      if (collaboration.primary.errors.some(error => error.code !== "REVIEW_BUDGET_EXHAUSTED")) return snapshot(true)
      if (!collaboration.primary.findings.some(hasCheckedRange)) throw new ReviewError("REVIEW_PRIMARY_INCOMPLETE")
      collaboration.primaryCompleted = true
    }
    collaboration.phase = "auditing"
    await publish()
    try {
      collaboration.audit = await auditReview({ primary: collaboration.primary!, pack: bundle.pack, env, fetcher: options.fetcher,
        signal, callsUsed, maxCalls, timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars,
        reasoningEffort: auditEffort, previousResult: collaboration.audit,
        onBeforeCall: reserve, onModelExchange: value => exchange("auditor", value),
        onCheckpoint: async value => { collaboration.audit = value; await publish() },
      })
    } catch (failure) {
      // 复核输入/摘要校验失败时丢弃可疑的旧复核结果，避免把被拒的数据继续展示或再持久化。
      collaboration.audit = undefined
      throw failure
    }
    if (collaboration.audit.status === "completed") collaboration.phase = "completed"
    await publish()
  } catch (error) { failures.push({ ...safeError(signal.aborted ? signal.reason : error), ruleIds: [] }) }
  finally {
    clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel)
    if (!signal.aborted) controller.abort(new ReviewError("REVIEW_CANCELLED"))
  }
  return snapshot(true)
}
