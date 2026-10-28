import { createHash } from "node:crypto"
import { prepareReviewInput, type ReviewInput } from "../input"
import { validateBundles, type SceneBundle } from "../bundles"
import { ReviewError, safeError } from "../errors"
import type { Collaboration, ReviewResult } from "../types"
import { reviewWithAgent, type AgentSettings } from "./run"
import { validateRoute } from "./router"
import { checkSceneApplicability, enforceRequestedScene } from "./applicability"
import { auditReview } from "./audit"
import { abortable } from "./abort"
import { publishedRules } from "../pack"
import { DEFAULT_AGENT_CALLS, MAX_AGENT_CALLS } from "../limits"
import { hasCheckedRange } from "../findings"
import { reviseContract, auditRevisedContract, repairRevisedContract, draftHash, revisionHash, REVISION_AUDIT_BATCH_SIZE } from "./revision"
import { canExportRevision } from "../revision"
import { roleEnvironment, type RoleModels } from "../../../../src/server/ai/roles"

export type MultiAgentOptions = ReviewInput & AgentSettings & {
  models?: RoleModels
  bundles: SceneBundle[]; env?: Record<string, string | undefined>; fetcher?: typeof fetch
  previousResult?: ReviewResult; auditEffort?: "default" | "low"
  workflow?: "multi-agent-v1" | "multi-agent-revision-v1"
  primaryStrategy?: "prepared-v1"; primaryEffort?: "default" | "low"; revisionEffort?: "default" | "low"
  revisionStrategy?: "prepared-v1"
  auditStrategy?: "prepared-v1"
  repairStrategy?: "one-round-v1"
  maxKnownTokens?: number
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function sumUsage(...values: ReviewResult["usage"][]): ReviewResult["usage"] {
  const known = values.filter(value => value !== null)
  return known.length ? known.reduce((sum, value) => ({ inputTokens: sum.inputTokens + value.inputTokens,
    outputTokens: sum.outputTokens + value.outputTokens, totalTokens: sum.totalTokens + value.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null
}

/** 各角色使用独立模型上下文，共享一个任务、固定交接快照和累计外发预算。 */
export async function reviewWithAgents(options: MultiAgentOptions): Promise<ReviewResult> {
  const bundles = structuredClone(options.bundles)
  const env = options.env ? { ...options.env } : undefined
  const auditEffort = options.auditEffort ?? "default"
  const workflow = options.workflow ?? "multi-agent-v1"
  if (!["multi-agent-v1", "multi-agent-revision-v1"].includes(workflow)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const revisionMode = workflow === "multi-agent-revision-v1"
  if (options.primaryStrategy !== undefined && options.primaryStrategy !== "prepared-v1" ||
    options.revisionStrategy !== undefined && options.revisionStrategy !== "prepared-v1" ||
    options.auditStrategy !== undefined && options.auditStrategy !== "prepared-v1" ||
    options.repairStrategy !== undefined && options.repairStrategy !== "one-round-v1" ||
    !["default", "low"].includes(options.primaryEffort ?? "default") || !["default", "low"].includes(options.revisionEffort ?? "default") ||
    options.maxKnownTokens !== undefined && (!Number.isSafeInteger(options.maxKnownTokens) || options.maxKnownTokens < 10000 || options.maxKnownTokens > 2000000)) throw new ReviewError("REVIEW_INPUT_INVALID")
  validateBundles(bundles)
  if (revisionMode && bundles.some(bundle => !bundle.revisionSkill)) throw new ReviewError("REVIEW_SKILL_INVALID")
  const maxCalls = options.maxCalls ?? DEFAULT_AGENT_CALLS, timeoutMs = options.timeoutMs ?? 600000
  let callsUsed = options.callsUsed ?? 0
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_AGENT_CALLS || !Number.isSafeInteger(callsUsed) || callsUsed < 0 || callsUsed > maxCalls ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !["default", "low"].includes(auditEffort)) throw new ReviewError("REVIEW_INPUT_INVALID")
  for (const [value, minimum, maximum] of [[options.maxPromptChars ?? 240000, 1000, 240000],
    [options.requestTimeoutMs ?? 90000, 1, 90000], [options.maxToolChars ?? 16000, 1000, 64000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ReviewError("REVIEW_INPUT_INVALID")
  }
  const prepared = prepareReviewInput(options, bundles[0].pack, options.models?.primary ?? ((env?.AI_MODEL ?? process.env.AI_MODEL)?.trim() || "glm-5.3-flash"), callsUsed)
  if (bundles.some(bundle => bundle.pack.manifest.status === "已停用" ||
    (prepared.result.mode === "published" && !publishedRules(bundle.pack).length))) throw new ReviewError("REVIEW_RULES_UNAVAILABLE")
  const candidates = bundles.map(item => item.candidate)
  const manifestSha256 = hash({ version: workflow, bundles: bundles.map(item => item.sha256), auditEffort,
    ...(options.context?.scene ? { requestedScene: options.context.scene } : {}),
    ...(options.models ? { models: options.models } : {}),
    primaryStrategy: options.primaryStrategy, revisionStrategy: options.revisionStrategy, auditStrategy: options.auditStrategy, repairStrategy: options.repairStrategy,
    primaryEffort: options.primaryEffort, revisionEffort: options.revisionEffort, maxKnownTokens: options.maxKnownTokens })
  const prior = options.previousResult ? structuredClone(options.previousResult) : undefined
  if (prior && (prior.collaboration?.manifestSha256 !== manifestSha256 || prior.input.textSha256 !== prepared.result.input.textSha256 ||
    prior.input.documentVersionId !== prepared.result.input.documentVersionId || prior.input.parseSnapshotId !== prepared.result.input.parseSnapshotId ||
    prior.callsUsed > callsUsed || prior.input.context.role !== prepared.context.role || prior.input.context.region !== prepared.context.region ||
    prior.model !== prepared.result.model)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const collaboration: Collaboration = prior?.collaboration ?? { version: workflow, manifestSha256, phase: "identifying", primaryCompleted: false }
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
    base.usage = sumUsage(collaboration.routing?.usage ?? null, collaboration.primary?.usage ?? null, collaboration.audit?.usage ?? null,
      collaboration.revision?.usage ?? null, collaboration.revisionAudit?.usage ?? null, collaboration.revisionRepair?.usage ?? null,
      collaboration.revisionRepair && collaboration.revisionAudit?.draftSha256 !== collaboration.revisionRepair.originalAudit.draftSha256 ? collaboration.revisionRepair.originalAudit.usage : null)
    base.errors.push(...(collaboration.routing?.errors ?? []).map(error => ({ ...error, ruleIds: [] })), ...failures)
    if (collaboration.audit?.errors.length) base.errors.push(...collaboration.audit.errors.map(error => ({ ...error, ruleIds: [] })))
    for (const value of [collaboration.revision, collaboration.revisionAudit]) if (value?.errors.length) base.errors.push(...value.errors.map(error => ({ ...error, ruleIds: [] })))
    const finished = revisionMode ? canExportRevision(collaboration.revision, collaboration.revisionAudit) : collaboration.audit?.status === "completed"
    if (final && collaboration.primaryCompleted && !finished && !(revisionMode && collaboration.revisionAudit?.status === "completed")) {
      const code = revisionMode ? "REVIEW_REVISION_INCOMPLETE" : "REVIEW_AUDIT_INCOMPLETE"
      base.errors.push({ code, message: new ReviewError(code).message, ruleIds: [] })
    }
    const valid = base.findings.some(hasCheckedRange)
    base.status = collaboration.primary?.status === "success" && finished && !base.errors.length ? "success" : valid ? "partial" : "failed"
    return base
  }
  const publish = async () => {
    signal.throwIfAborted()
    try {
      const current = snapshot()
      await abortable(Promise.resolve(options.onProgress?.({ stage: collaboration.phase, reviewId: current.reviewId, callsUsed,
        agentRole: collaboration.phase === "identifying" ? "router" : collaboration.phase === "reviewing" ? "primary" : collaboration.phase === "revising" ? "reviser" : "auditor",
        readParagraphCount: collaboration.primary?.agent?.readParagraphIndexes.length ?? collaboration.routing?.readParagraphIndexes.length ?? 0,
        paragraphCount: prepared.paragraphs.length, submittedRuleCount: collaboration.primary?.findings.filter(item => item.checkedParagraphIndexes).length ?? 0,
        auditedRuleCount: collaboration.revisionAudit?.checks.length ?? collaboration.audit?.checks.length ?? 0,
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
    if (options.maxKnownTokens && (snapshot().usage?.totalTokens ?? 0) >= options.maxKnownTokens) throw new ReviewError("REVIEW_TOKEN_BUDGET_EXHAUSTED")
    await abortable(Promise.resolve(options.onBeforeCall?.(reservation)), signal)
    callsUsed = reservation.callNumber
  }
  const exchange = async (role: "router" | "primary" | "reviser" | "auditor", value: { callNumber: number; request: unknown; response: unknown }) => {
    await abortable(Promise.resolve(options.onModelExchange?.({ ...value, agentRole: role })), signal)
  }
  try {
    await publish()
    if (!collaboration.routing?.selection) {
      collaboration.phase = "identifying"
      const oldUsage = collaboration.routing?.usage ?? null
      collaboration.routing = await checkSceneApplicability({ paragraphs: prepared.paragraphs, candidates, context: prepared.context, complete: prepared.result.input.complete,
        env: roleEnvironment(env, options.models, "router"), fetcher: options.fetcher, signal, callsUsed, maxCalls: Math.min(4, maxCalls), timeoutMs: remainingTime(),
        requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars, onBeforeCall: reserve,
        onModelExchange: value => exchange("router", value),
        onCheckpoint: async value => { collaboration.routing = { ...value, usage: sumUsage(oldUsage, value.usage) }; await publish() },
      })
      collaboration.routing.usage = sumUsage(oldUsage, collaboration.routing.usage)
    }
    const routing = enforceRequestedScene(collaboration.routing, prepared.context.scene)
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
      const ruleCount = bundle.pack.rules.filter(rule => rule.status !== "已停用").length
      const reserveForAudit = revisionMode ? Math.ceil(ruleCount / REVISION_AUDIT_BATCH_SIZE) + Math.ceil(ruleCount / 6) : Math.ceil(ruleCount / 3) + 1
      const primaryLimit = Math.max(1, maxCalls - reserveForAudit)
      if (callsUsed >= primaryLimit) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
      collaboration.primary = await reviewWithAgent({ paragraphs: prepared.paragraphs, complete: prepared.result.input.complete,
        documentTitle: prepared.result.documentTitle, documentVersionId: prepared.result.input.documentVersionId, parseSnapshotId: prepared.result.input.parseSnapshotId,
        context, mode: prepared.result.mode, pack: bundle.pack, skill: bundle.skill, env: roleEnvironment(env, options.models, "primary"), fetcher: options.fetcher, signal,
        strategy: options.primaryStrategy, reasoningEffort: options.primaryEffort,
        callsUsed, maxCalls: primaryLimit, timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs,
        maxPromptChars: options.maxPromptChars, maxToolChars: options.maxToolChars, previousResult: collaboration.primary,
        onBeforeCall: reserve, onModelExchange: value => exchange("primary", value),
        onCheckpoint: async value => { collaboration.primary = value; await publish() },
      })
      if (collaboration.primary.errors.some(error => error.code !== "REVIEW_BUDGET_EXHAUSTED")) return snapshot(true)
      if (!collaboration.primary.findings.some(hasCheckedRange)) throw new ReviewError("REVIEW_PRIMARY_INCOMPLETE")
      collaboration.primaryCompleted = true
    }
    if (revisionMode) {
      if (!bundle.revisionSkill) throw new ReviewError("REVIEW_SKILL_INVALID")
      const reserveForAudit = Math.ceil(collaboration.primary!.findings.length / REVISION_AUDIT_BATCH_SIZE)
      collaboration.phase = "revising"
      await publish()
      const revisionLimit = maxCalls - reserveForAudit
      if (collaboration.revision?.status !== "completed" && callsUsed >= revisionLimit) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
      try { collaboration.revision = await reviseContract({ primary: collaboration.primary!, pack: bundle.pack, skill: bundle.revisionSkill,
        env: roleEnvironment(env, options.models, "primary"), fetcher: options.fetcher, signal, callsUsed, maxCalls: Math.max(callsUsed, revisionLimit), timeoutMs: remainingTime(),
        reasoningEffort: options.revisionEffort,
        strategy: options.revisionStrategy,
        requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars, previous: collaboration.revision,
        onBeforeCall: reserve, onModelExchange: value => exchange("reviser", value),
        onCheckpoint: async value => { collaboration.revision = value; await publish() },
      }) } catch (failure) { collaboration.revision = undefined; collaboration.revisionAudit = undefined; throw failure }
      if (collaboration.revision.status !== "completed") return snapshot(true)
      collaboration.phase = "auditing"
      await publish()
      try {
        collaboration.revisionAudit = await auditRevisedContract({ primary: collaboration.primary!, draft: collaboration.revision, pack: bundle.pack,
          env: roleEnvironment(env, options.models, "auditor"), fetcher: options.fetcher, signal, callsUsed, maxCalls, timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs, reasoningEffort: auditEffort,
          maxPromptChars: options.maxPromptChars, previous: collaboration.revisionAudit,
          strategy: options.auditStrategy,
          onBeforeCall: reserve, onModelExchange: value => exchange("auditor", value),
          onCheckpoint: async value => { collaboration.revisionAudit = value; await publish() },
        })
      } catch (failure) { collaboration.revisionAudit = undefined; throw failure }
      if (options.repairStrategy && collaboration.revisionAudit.status === "completed") {
        const audit = collaboration.revisionAudit
        const unsafe = audit.checks.some(item => item.outcome === "存在问题")
        if (unsafe && !collaboration.revisionRepair) {
          if (callsUsed + 1 + reserveForAudit > maxCalls) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
          collaboration.revisionRepair = { status: "started", originalDraft: structuredClone(collaboration.revision), originalAudit: structuredClone(audit), callsUsed, usage: null, errors: [] }
          await publish()
          collaboration.phase = "revising"
          collaboration.revisionRepair = await repairRevisedContract({ primary: collaboration.primary!, pack: bundle.pack,
            repair: collaboration.revisionRepair, env: roleEnvironment(env, options.models, "primary"), fetcher: options.fetcher, signal, callsUsed, maxCalls: callsUsed + 1,
            timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars,
            reasoningEffort: options.revisionEffort, onBeforeCall: reserve, onModelExchange: value => exchange("reviser", value),
            onCheckpoint: async value => { collaboration.revisionRepair = value; await publish() },
          })
          await publish()
        } else if (collaboration.revisionRepair?.status === "started") {
          // A crash after recording the attempt must not send another repair request.
          collaboration.revisionRepair.status = "failed"
          collaboration.revisionRepair.errors.push({ code: "REVIEW_REVISION_UNSAFE", message: new ReviewError("REVIEW_REVISION_UNSAFE").message })
          await publish()
        }
        const repair = collaboration.revisionRepair
        if (repair?.status === "repaired" && repair.draft && collaboration.revision.sha256 === repair.originalDraft.sha256) {
          if (repair.originalDraft.sha256 !== draftHash(repair.originalDraft) || repair.originalAudit.draftSha256 !== repair.originalDraft.sha256 ||
              repair.draft.sha256 !== draftHash(repair.draft) || repair.draft.primarySha256 !== revisionHash(collaboration.primary!)) throw new ReviewError("REVIEW_INPUT_INVALID")
          collaboration.revision = repair.draft
          collaboration.revisionAudit = undefined
          collaboration.phase = "auditing"
          await publish()
          collaboration.revisionAudit = await auditRevisedContract({ primary: collaboration.primary!, draft: collaboration.revision, pack: bundle.pack,
            env: roleEnvironment(env, options.models, "auditor"), fetcher: options.fetcher, signal, callsUsed, maxCalls, timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs,
            reasoningEffort: auditEffort, maxPromptChars: options.maxPromptChars, strategy: options.auditStrategy,
            onBeforeCall: reserve, onModelExchange: value => exchange("auditor", value),
            onCheckpoint: async value => { collaboration.revisionAudit = value; await publish() },
          })
        }
      }
      if (collaboration.revisionAudit?.status === "completed") {
        collaboration.phase = "completed"
        if (!canExportRevision(collaboration.revision, collaboration.revisionAudit)) failures.push({ code: "REVIEW_REVISION_UNSAFE", message: new ReviewError("REVIEW_REVISION_UNSAFE").message, ruleIds: [] })
      }
      await publish()
      return snapshot(true)
    }
    collaboration.phase = "auditing"
    await publish()
    try {
      collaboration.audit = await auditReview({ primary: collaboration.primary!, pack: bundle.pack, env: roleEnvironment(env, options.models, "auditor"), fetcher: options.fetcher,
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

export type RevisionOnlyOptions = AgentSettings & {
  models?: RoleModels
  primary: ReviewResult
  ruleIds: string[]
  bundles: SceneBundle[]
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  revisionEffort?: "default" | "low"
  auditEffort?: "default" | "low"
  maxKnownTokens?: number
  previousResult?: ReviewResult
  onProgress?: AgentSettings["onProgress"]
  onCheckpoint?: AgentSettings["onCheckpoint"]
}

/** 仅修订任务：固定已保存的主审结果，只修订并核对用户选中的规则，不重新路由或主审。 */
export async function reviewRevisionOnly(options: RevisionOnlyOptions): Promise<ReviewResult> {
  const primary = structuredClone(options.primary), bundles = structuredClone(options.bundles)
  const ruleIds = [...new Set(options.ruleIds)]
  if (!primary.input.complete || primary.sceneSelection?.status !== "matched" || primary.collaboration?.version !== "multi-agent-v1" ||
    !ruleIds.length || ruleIds.length > 22 || ruleIds.some(id => !primary.findings.some(item => item.ruleId === id &&
      !item.placeholder && (item.kind === "发现问题" || item.kind === "缺失条款") && item.basis.length))) throw new ReviewError("REVIEW_INPUT_INVALID")
  validateBundles(bundles)
  const bundle = bundles.find(item => item.candidate.id === primary.sceneSelection!.sceneId)
  if (!bundle?.revisionSkill) throw new ReviewError("REVIEW_SKILL_INVALID")
  const revisionEffort = options.revisionEffort ?? "default", auditEffort = options.auditEffort ?? "default"
  const maxCalls = options.maxCalls ?? DEFAULT_AGENT_CALLS, timeoutMs = options.timeoutMs ?? 600000
  let callsUsed = options.callsUsed ?? 0
  const env = options.env ? { ...options.env } : undefined
  if (!["default", "low"].includes(revisionEffort) || !["default", "low"].includes(auditEffort) ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_AGENT_CALLS || !Number.isSafeInteger(callsUsed) || callsUsed < 0 || callsUsed > maxCalls ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 ||
    options.maxKnownTokens !== undefined && (!Number.isSafeInteger(options.maxKnownTokens) || options.maxKnownTokens < 10000 || options.maxKnownTokens > 2000000))
    throw new ReviewError("REVIEW_INPUT_INVALID")
  const manifestSha256 = hash({ version: "revision-only-v1", bundles: bundles.map(item => item.sha256), primary: revisionHash(primary),
    ...(options.models ? { models: options.models } : {}),
    ruleIds, revisionEffort, auditEffort, maxKnownTokens: options.maxKnownTokens })
  const prior = options.previousResult ? structuredClone(options.previousResult) : undefined
  if (prior && (prior.collaboration?.version !== "revision-only-v1" || prior.collaboration.manifestSha256 !== manifestSha256 ||
    revisionHash(prior.collaboration.primary) !== revisionHash(primary) || prior.callsUsed > callsUsed)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const collaboration: Collaboration = prior?.collaboration ?? { version: "revision-only-v1", manifestSha256, phase: "revising", primaryCompleted: true, primary }
  const start = Date.now(), controller = new AbortController(), signal = controller.signal
  const timeout = setTimeout(() => controller.abort(new ReviewError("REVIEW_TIMEOUT")), timeoutMs)
  const cancel = () => controller.abort(new ReviewError("REVIEW_CANCELLED"))
  options.signal?.addEventListener("abort", cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const failures: ReviewResult["errors"] = []
  const remainingTime = () => Math.max(1, timeoutMs - (Date.now() - start))
  const snapshot = (final = false): ReviewResult => {
    const base = structuredClone(primary)
    base.collaboration = structuredClone(collaboration)
    base.sceneCandidates = structuredClone(primary.sceneCandidates)
    base.sceneSelection = structuredClone(primary.sceneSelection)
    base.callsUsed = callsUsed
    base.usage = sumUsage(collaboration.revision?.usage ?? null, collaboration.revisionAudit?.usage ?? null)
    base.errors = [...(primary.errors ?? []), ...failures]
    const finished = canExportRevision(collaboration.revision, collaboration.revisionAudit)
    if (final && !finished) {
      const code = collaboration.revisionAudit?.status === "completed" ? "REVIEW_REVISION_UNSAFE" : "REVIEW_REVISION_INCOMPLETE"
      if (!base.errors.some(item => item.code === code)) base.errors.push({ code, message: new ReviewError(code).message, ruleIds: [] })
    }
    const valid = primary.findings.some(hasCheckedRange)
    base.status = primary.status === "success" && finished && !base.errors.length ? "success" : valid ? "partial" : "failed"
    return base
  }
  const publish = async () => {
    signal.throwIfAborted()
    try {
      const current = snapshot()
      await abortable(Promise.resolve(options.onProgress?.({ stage: collaboration.phase, reviewId: current.reviewId, callsUsed,
        agentRole: collaboration.phase === "revising" ? "reviser" : "auditor",
        readParagraphCount: primary.agent?.readParagraphIndexes.length ?? primary.paragraphs.length, paragraphCount: primary.paragraphs.length,
        submittedRuleCount: primary.findings.filter(item => item.checkedParagraphIndexes).length,
        auditedRuleCount: collaboration.revisionAudit?.checks.length ?? 0,
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
    if (options.maxKnownTokens && (snapshot().usage?.totalTokens ?? 0) >= options.maxKnownTokens) throw new ReviewError("REVIEW_TOKEN_BUDGET_EXHAUSTED")
    await abortable(Promise.resolve(options.onBeforeCall?.(reservation)), signal)
    callsUsed = reservation.callNumber
  }
  const exchange = async (role: "reviser" | "auditor", value: { callNumber: number; request: unknown; response: unknown }) => {
    await abortable(Promise.resolve(options.onModelExchange?.({ ...value, agentRole: role })), signal)
  }
  try {
    await publish()
    if (collaboration.revision?.status !== "completed") {
      collaboration.phase = "revising"
      await publish()
      const reserveForAudit = Math.ceil(ruleIds.length / REVISION_AUDIT_BATCH_SIZE)
      const revisionLimit = Math.max(1, maxCalls - reserveForAudit)
      if (callsUsed >= revisionLimit) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
      collaboration.revision = await reviseContract({ primary, pack: bundle.pack, skill: bundle.revisionSkill, targets: ruleIds,
        strategy: "prepared-v1", env: roleEnvironment(env, options.models, "primary"), fetcher: options.fetcher, signal, callsUsed, maxCalls: Math.max(callsUsed, revisionLimit),
        timeoutMs: remainingTime(), requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars,
        reasoningEffort: revisionEffort, previous: collaboration.revision,
        onBeforeCall: reserve, onModelExchange: value => exchange("reviser", value),
        onCheckpoint: async value => { collaboration.revision = value; await publish() },
      })
      if (collaboration.revision.status !== "completed") {
        failures.push({ code: "REVIEW_REVISION_INCOMPLETE", message: new ReviewError("REVIEW_REVISION_INCOMPLETE").message, ruleIds: [] })
        return snapshot(true)
      }
    }
    if (collaboration.revisionAudit?.status !== "completed") {
      collaboration.phase = "auditing"
      await publish()
      collaboration.revisionAudit = await auditRevisedContract({ primary, draft: collaboration.revision, pack: bundle.pack, targets: ruleIds,
        strategy: "prepared-v1", env: roleEnvironment(env, options.models, "auditor"), fetcher: options.fetcher, signal, callsUsed, maxCalls, timeoutMs: remainingTime(),
        requestTimeoutMs: options.requestTimeoutMs, maxPromptChars: options.maxPromptChars, reasoningEffort: auditEffort,
        previous: collaboration.revisionAudit,
        onBeforeCall: reserve, onModelExchange: value => exchange("auditor", value),
        onCheckpoint: async value => { collaboration.revisionAudit = value; await publish() },
      })
    }
    collaboration.phase = "completed"
    await publish()
  } catch (error) {
    failures.push({ ...safeError(signal.aborted ? signal.reason : error), ruleIds: [] })
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel)
    if (!signal.aborted) controller.abort(new ReviewError("REVIEW_CANCELLED"))
  }
  return snapshot(true)
}
