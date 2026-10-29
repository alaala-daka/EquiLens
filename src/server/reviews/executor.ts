import type { ProjectAccess, ProjectAction, ProjectExecutionAccess } from "../../lib/business/contracts"
import type { ReviewResult } from "../../../tools/contract-review/src/types"
import type { AuthIdentity } from "../auth/service"
import { isBusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultDependency, ResultService, ResultSource } from "../results/service"
import type { TaskExecutionResult, TaskExecutor } from "../tasks/runner-core"
import { estimateTaskCall } from "../tasks/estimates"
import {
  ProjectReviewError, isProjectReviewError, projectReviewFailureMessages, taskFailureCode,
  type ProjectReviewFailureCode,
} from "./errors"
import { loadReviewInput, retentionExpired, type LoadedReviewInput, type ReviewInputDependencies } from "./input"

/**
 * A4c project contract-review executor.
 *
 * Runs inside the unified task runner (A3c) after its own authorization check.
 * Every stage rechecks account/project/material authorization and retention
 * before any paid model request; each model call is reserved through the shared
 * A3b budget ledger. A successful run writes exactly one new immutable machine
 * result version through ResultService (never a human version, never a test
 * fixture), then reports the real task outcome.
 *
 * The model runner is injected: production wires reviewWithAgent, tests inject
 * a deterministic fake so no real model traffic is produced by the test suite.
 */
export type ProjectReviewRunnerInput = {
  paragraphs: Array<{ index: number; text: string; location: string }>
  complete: boolean
  documentTitle: string
  documentVersionId: string
  parseSnapshotId: string
  textSha256: string
  context: { scene: string; role: "专业分包人"; region: string }
  maxCalls: number
  signal: AbortSignal
  env: Record<string, string | undefined>
  onBeforeCall(reservation: { callNumber: number }): Promise<void>
  onExchange(exchange: unknown): Promise<void>
}

export type ProjectReviewRunner = (input: ProjectReviewRunnerInput) => Promise<ReviewResult>

export type ProjectReviewExecutorDependencies = {
  repository: ReviewInputDependencies["repository"]
  store: ReviewInputDependencies["store"]
  readProjectRetention: ReviewInputDependencies["readProjectRetention"]
  results: Pick<ResultService, "saveResultRevision">
  runner: ProjectReviewRunner
  /** Server-side execution identity snapshot for the result writer; never a browser session. */
  identityFor: (accountId: string) => AuthIdentity
  authorize: (input: { accountId: string; projectId: string; action: ProjectAction }) => Promise<ProjectExecutionAccess>
  env?: Record<string, string | undefined>
  now?: () => Date
}

const paused = (): Error => Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })

function failed(code: ProjectReviewFailureCode, message = projectReviewFailureMessages[code]): TaskExecutionResult {
  return { outcome: "failed", errorCode: code, errorMessage: message }
}

/** Map every finding/citation to the immutable project fragment that contains it. */
function mapSources(loaded: LoadedReviewInput, result: ReviewResult): ResultSource[] | null {
  const sources: ResultSource[] = []
  const seen = new Set<string>()
  const add = (paragraphIndex: unknown, quote: unknown): boolean => {
    if (!Number.isInteger(paragraphIndex) || typeof quote !== "string" || !quote.trim()) return false
    const source = loaded.paragraphSources.get(paragraphIndex as number)
    if (!source || !source.fragmentText.includes(quote)) return false
    const key = `${source.snapshotId}:${source.fragmentId}:${quote}`
    if (!seen.has(key)) {
      seen.add(key)
      sources.push({ fragmentId: source.fragmentId, snapshotId: source.snapshotId, quote })
    }
    return true
  }
  for (const finding of result.findings ?? []) {
    if (!finding || finding.placeholder) continue
    if (typeof finding.quote === "string" && finding.quote.trim() && !add(finding.paragraphIndex, finding.quote)) return null
    for (const citation of finding.citations ?? []) {
      if (!citation || typeof citation.quote !== "string" || !citation.quote.trim()) continue
      if (!add(citation.paragraphIndex, citation.quote)) return null
    }
  }
  return sources
}

function resultDependencies(loaded: LoadedReviewInput, result: ReviewResult): ResultDependency[] {
  const dependencies: ResultDependency[] = loaded.materials.map(material => ({
    kind: "material", id: material.materialId, versionId: material.versionId,
  }))
  if (typeof result.packVersion === "string" && result.packVersion.trim()) {
    dependencies.push({ kind: "rule", id: "builtin-contract-review-rules", versionId: result.packVersion.slice(0, 128) })
  }
  return dependencies
}

export function createProjectReviewExecutor(dependencies: ProjectReviewExecutorDependencies): TaskExecutor {
  const env = dependencies.env ?? process.env
  const now = () => dependencies.now?.() ?? new Date()
  return async (job, context) => {
    if (job.kind !== "contract-review") return failed("INVALID_SUBMISSION")
    const identity = dependencies.identityFor(job.owner)
    const authorize: ResultAuthorizer = async (_identity, projectId, action) => {
      const access = await dependencies.authorize({ accountId: job.owner, projectId, action })
      const granted: ProjectAccess = { projectId, action, role: access.role, identity }
      return granted
    }
    const revalidateRetention = async (loaded: LoadedReviewInput): Promise<void> => {
      const current = now()
      const projectRetention = await dependencies.readProjectRetention(job.projectId)
      if (!projectRetention) throw new ProjectReviewError("INVALID_SOURCE")
      if (retentionExpired(projectRetention, current)) throw new ProjectReviewError("RETENTION_EXPIRED")
      for (const material of loaded.materials) {
        const record = await dependencies.repository.findMaterial(job.projectId, material.materialId)
        if (!record || record.status !== "active" || !record.processingAuthorized) throw new ProjectReviewError("INVALID_SOURCE")
        if (retentionExpired(record.retentionUntil, current)) throw new ProjectReviewError("RETENTION_EXPIRED")
      }
    }
    const blockedFailure = (blocked: unknown): TaskExecutionResult => {
      if (taskFailureCode(blocked) === "ACCESS_REVOKED") throw blocked
      if (isProjectReviewError(blocked)) return failed(blocked.code)
      if (taskFailureCode(blocked) === "BUDGET_EXHAUSTED") return failed("REVIEW_BUDGET_EXHAUSTED")
      return failed("REVIEW_RESERVATION_FAILED")
    }
    try {
      await context.refreshAccess()
      const loaded = await loadReviewInput({
        repository: dependencies.repository,
        store: dependencies.store,
        readProjectRetention: dependencies.readProjectRetention,
        refreshAccess: context.refreshAccess,
        now: dependencies.now,
      }, job)
      if (!loaded.unreviewedMaterialsConsent) return failed("UNREVIEWED_MATERIALS_CONSENT")
      await context.refreshAccess()
      const remainingCalls = job.maxCalls - job.callsUsed
      if (remainingCalls <= 0) return failed("REVIEW_BUDGET_EXHAUSTED")

      let blocked: unknown
      // Measure each model exchange so the 600s task budget reflects actual
      // execution time instead of holding a 90s reservation per call; otherwise
      // a 25-call review could never pass the cumulative time budget.
      const callStarted = new Map<number, number>()
      const result = await dependencies.runner({
        paragraphs: loaded.paragraphs,
        complete: loaded.complete,
        documentTitle: loaded.documentTitle,
        documentVersionId: loaded.documentVersionId,
        parseSnapshotId: loaded.parseSnapshotId,
        textSha256: loaded.textSha256,
        context: { scene: loaded.scene, role: loaded.role, region: loaded.region },
        maxCalls: remainingCalls,
        signal: context.signal,
        env,
        onBeforeCall: async reservation => {
          try {
            await context.refreshAccess()
            await revalidateRetention(loaded)
            // The plan's runner input has no callsUsed; the executor keeps the
            // persistent call counter continuous across recovered attempts.
            const callNumber = job.callsUsed + reservation.callNumber
            if (callNumber > job.maxCalls) throw Object.assign(new Error("任务调用预算不允许本次外部请求。"), { code: "BUDGET_EXHAUSTED" })
            await context.reserveCall(callNumber, estimateTaskCall(job.kind, callNumber))
            callStarted.set(reservation.callNumber, Date.now())
          } catch (failure) {
            blocked ??= failure
            throw failure
          }
        },
        onExchange: async exchange => {
          const value = exchange as { callNumber?: unknown } | null
          const local = value && typeof value.callNumber === "number" && Number.isSafeInteger(value.callNumber) ? value.callNumber : null
          if (local === null) return
          const started = callStarted.get(local)
          if (started === undefined) return
          callStarted.delete(local)
          // Cost usage is unknown here and stays conservatively reserved; only
          // the measured wall time is settled back into the task time budget.
          await context.settleCall(job.callsUsed + local, { timeMs: Math.max(0, Date.now() - started), costFen: null })
        },
      })
      if (blocked) return blockedFailure(blocked)
      context.signal.throwIfAborted()
      if (!result || result.schemaVersion !== 1) return failed("RESULT_MISMATCH")
      if (result.input?.textSha256 !== loaded.textSha256 || result.input?.parseSnapshotId !== loaded.parseSnapshotId ||
        result.input?.documentVersionId !== loaded.documentVersionId || result.input?.complete !== loaded.complete) {
        return failed("RESULT_MISMATCH")
      }
      if (result.status === "failed") {
        const code = typeof result.errors?.[0]?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(result.errors[0].code)
          ? result.errors[0].code : "REVIEW_MODEL_FAILED"
        return { outcome: "failed", errorCode: code, errorMessage: "审查未形成有效结论，任务已停止；未保存机器成果。" }
      }
      const sources = mapSources(loaded, result)
      if (!sources) return failed("INVALID_SOURCE", "机器结果引用了任务外的材料片段，未保存成果。")
      const saved = await dependencies.results.saveResultRevision(identity, authorize, {
        projectId: job.projectId,
        kind: "contract-review",
        baseVersionId: "",
        operationId: `review:${job.id}:${job.attempt}`,
        reason: "项目合同审查机器成果",
        value: result,
        sources,
        dependencies: resultDependencies(loaded, result),
      }, {
        output: result,
        taskId: job.id,
        attempt: job.attempt,
        executionToken: job.token,
      })
      if (saved.validation.status === "invalid") return failed("RESULT_INVALID")
      return {
        outcome: result.status === "success" ? "success" : "partial",
        resultSummary: JSON.stringify({
          resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256,
          status: result.status, validation: saved.validation.status,
        }),
      }
    } catch (failure) {
      const code = taskFailureCode(failure)
      if (code === "ACCESS_REVOKED") throw failure
      if (context.signal.aborted) throw failure
      if (isProjectReviewError(failure)) return failed(failure.code)
      if (isBusinessError(failure)) {
        if (failure.code === "FORBIDDEN" || failure.code === "UNAUTHENTICATED") throw paused()
        if (failure.code === "BUDGET_EXHAUSTED") return failed("REVIEW_BUDGET_EXHAUSTED")
        if (failure.code === "SERVICE_UNAVAILABLE") return failed("SERVICE_UNAVAILABLE")
        if (failure.code === "CONFLICT") return { outcome: "failed", errorCode: "CONFLICT", errorMessage: "任务执行权或成果版本已变化，机器成果未保存。" }
        return failed("RESULT_SAVE_FAILED")
      }
      // ReviewError from the injected runner keeps its controlled code/message.
      if (code && code.startsWith("REVIEW_")) {
        const message = failure instanceof Error && failure.message ? failure.message : "审查执行失败，任务已停止。"
        return { outcome: "failed", errorCode: code, errorMessage: message.slice(0, 200) }
      }
      throw failure
    }
  }
}
