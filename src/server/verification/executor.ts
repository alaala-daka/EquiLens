import type { ProjectAccess, ProjectAction, ProjectExecutionAccess } from "../../lib/business/contracts"
import type {
  BidVerificationValue, ExternalRecordSnapshot, RequirementSetValue, RequirementSnapshot,
} from "../../lib/business/verification-types"
import type { AuthIdentity } from "../auth/service"
import { isBusinessError } from "../projects/errors"
import { retentionExpired } from "../reviews/input"
import type { ResultAuthorizer, ResultDependency, ResultService, ResultSource } from "../results/service"
import { estimateTaskCall } from "../tasks/estimates"
import type { TaskExecutionResult, TaskExecutor } from "../tasks/runner-core"
import { compareRequirements, type CompareInput, type CompareOutput } from "./compare"
import type { BidRequirementExtractor } from "./extractor"
import type { FieldSource } from "./field-source"
import {
  loadBidRequirementsInput, loadBidVerificationInput,
  type BidRequirementsInputDependencies, type BidVerificationInputDependencies,
} from "./input"
import type { VerificationRecordRepository } from "./records-repository"
import { parseRequirementCandidates } from "./requirements"
import { VerificationError, isVerificationError, taskFailureCode, verificationFailureMessages } from "./types"

/**
 * C4-VERIFY task executors (plan §4.7/§5).
 *
 * Both executors run inside the unified task runner (A3c) after its own
 * authorization check. Every stage rechecks account/project/material access and
 * retention before any input is used; the deterministic comparison performs no
 * external request and reserves no paid call.
 *
 * - `bid-requirements`: the injected extractor only proposes candidates; quotes
 *   are mapped verbatim to project fragments and saved as a `candidate` value
 *   that a human must confirm. A failed extraction saves nothing.
 * - `bid-verification`: reads the confirmed requirement-set version, current
 *   field values and exactly the pinned manual records, then writes one new
 *   machine result version. Re-runs create a new result id; an invalid machine
 *   result is saved for audit but reported as a failed task.
 */
export type VerificationExecutionDependencies = {
  repository: BidVerificationInputDependencies["repository"] & BidRequirementsInputDependencies["repository"]
  records: Pick<VerificationRecordRepository, "findById">
  fieldSource: FieldSource
  results: Pick<ResultService, "get" | "saveResultRevision">
  readProjectRetention: (projectId: string) => Promise<string | null>
  identityFor: (accountId: string) => AuthIdentity
  authorize: (input: { accountId: string; projectId: string; action: ProjectAction }) => Promise<ProjectExecutionAccess>
  now?: () => Date
}

export type BidVerificationExecutorDependencies = VerificationExecutionDependencies & {
  /** Injected in tests to isolate the executor; production uses the deterministic engine. */
  compare?: (input: CompareInput) => CompareOutput
}

export type BidRequirementsExecutorDependencies = Omit<VerificationExecutionDependencies, "records" | "fieldSource" | "results"> & {
  results: Pick<ResultService, "saveResultRevision">
  extractor: BidRequirementExtractor
  env?: Record<string, string | undefined>
}

const paused = (): Error => Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })

/** Fixed warning for material text with parse coverage restrictions (bid-requirements). */
export const PARTIAL_COVERAGE_WARNING = "所选材料存在解析覆盖限制，要求候选仅基于部分原文，不能视为全面资格要求检查；未覆盖范围须人工核对。"

function failed(code: string, message?: string): TaskExecutionResult {
  const fixed = (verificationFailureMessages as Record<string, string>)[code]
  return { outcome: "failed", errorCode: code, errorMessage: message ?? fixed ?? "核验执行失败，任务已停止。" }
}

function identityAuthorizer(
  dependencies: Pick<VerificationExecutionDependencies, "authorize">,
  owner: string,
  identity: AuthIdentity,
): ResultAuthorizer {
  return async (_identity, projectId, action) => {
    const access = await dependencies.authorize({ accountId: owner, projectId, action })
    const granted: ProjectAccess = { projectId, action, role: access.role, identity }
    return granted
  }
}

function blockedFailure(blocked: unknown): TaskExecutionResult {
  if (taskFailureCode(blocked) === "ACCESS_REVOKED") throw blocked
  if (isVerificationError(blocked)) return failed(blocked.code)
  if (taskFailureCode(blocked) === "BUDGET_EXHAUSTED") return failed("BUDGET_EXHAUSTED")
  if (taskFailureCode(blocked) === "SERVICE_UNAVAILABLE") return failed("SERVICE_UNAVAILABLE")
  // Any other extractor/reservation failure is a controlled extraction failure.
  return failed("EXTRACTOR_FAILED")
}

function saveFailure(failure: unknown): TaskExecutionResult {
  if (taskFailureCode(failure) === "ACCESS_REVOKED") throw failure
  if (isVerificationError(failure)) return failed(failure.code)
  if (isBusinessError(failure)) {
    if (failure.code === "FORBIDDEN" || failure.code === "UNAUTHENTICATED") throw paused()
    if (failure.code === "BUDGET_EXHAUSTED") return failed("BUDGET_EXHAUSTED")
    if (failure.code === "SERVICE_UNAVAILABLE") return failed("SERVICE_UNAVAILABLE")
    if (failure.code === "CONFLICT") return failed("CONFLICT", "任务执行权或成果版本已变化，机器成果未保存。")
    if (failure.code === "INVALID_SOURCE") return failed("RESULT_INVALID")
    return failed("RESULT_SAVE_FAILED")
  }
  throw failure
}

function dependencyList(materials: Array<{ materialId: string; versionId: string }>): ResultDependency[] {
  return materials.map(material => ({ kind: "material" as const, id: material.materialId, versionId: material.versionId }))
}

export function createBidVerificationExecutor(dependencies: BidVerificationExecutorDependencies): TaskExecutor {
  const compare = dependencies.compare ?? compareRequirements
  return async (job, context) => {
    if (job.kind !== "bid-verification") return failed("INVALID_SUBMISSION")
    const identity = dependencies.identityFor(job.owner)
    const authorize = identityAuthorizer(dependencies, job.owner, identity)
    try {
      await context.refreshAccess()
      const loaded = await loadBidVerificationInput(job, {
        repository: dependencies.repository,
        records: dependencies.records,
        results: dependencies.results as Pick<ResultService, "get">,
        fieldSource: dependencies.fieldSource,
        readProjectRetention: dependencies.readProjectRetention,
        refreshAccess: context.refreshAccess,
        identity,
        authorize,
        now: dependencies.now,
      })
      context.signal.throwIfAborted()
      const compared = compare({
        requirements: loaded.requirements,
        fieldValues: loaded.fieldValues,
        records: loaded.records,
        asOf: loaded.asOf,
      })
      if (!compared || !Array.isArray(compared.items) || compared.items.length !== loaded.requirements.length ||
        !Array.isArray(compared.unfinished) || !Array.isArray(compared.warnings) || !Array.isArray(compared.errors) ||
        !compared.coverage || typeof compared.coverage !== "object" || (compared.status !== "success" && compared.status !== "partial")) {
        return failed("RESULT_MISMATCH")
      }
      const value: BidVerificationValue = {
        schemaVersion: 1,
        status: compared.status,
        asOf: loaded.asOf,
        requirementSet: {
          id: loaded.requirementSet.resultId,
          versionId: loaded.requirementSet.versionId,
          sha256: loaded.requirementSet.sha256,
          requirements: loaded.requirements,
        },
        materials: loaded.materials.map(material => ({ materialId: material.materialId, versionId: material.versionId, sha256: material.sha256 })),
        records: loaded.records.map(record => ({ ...record })),
        items: compared.items,
        coverage: compared.coverage,
        unfinished: compared.unfinished,
        warnings: compared.warnings,
        errors: compared.errors,
      }
      // Persist only JSON-normalized data so canonical serialization cannot fail.
      let normalized: BidVerificationValue
      try { normalized = JSON.parse(JSON.stringify(value)) as BidVerificationValue } catch { return failed("RESULT_MISMATCH") }
      await context.refreshAccess()
      const resultDependencies: ResultDependency[] = [
        { kind: "result", id: loaded.requirementSet.resultId, versionId: loaded.requirementSet.versionId },
        ...dependencyList(loaded.materials),
      ]
      const saved = await dependencies.results.saveResultRevision(identity, authorize, {
        projectId: job.projectId,
        kind: "bid-verification",
        baseVersionId: "",
        operationId: `bid-verification:${job.id}:${job.attempt}`,
        reason: "投标材料核验机器成果",
        value: normalized,
        sources: loaded.requirementSources,
        dependencies: resultDependencies,
      }, {
        output: normalized,
        taskId: job.id,
        attempt: job.attempt,
        executionToken: job.token,
      })
      if (saved.validation.status === "invalid") return failed("RESULT_INVALID")
      return {
        outcome: normalized.status === "success" ? "success" : "partial",
        resultSummary: JSON.stringify({
          resultId: saved.resultId,
          versionId: saved.versionId,
          sha256: saved.sha256,
          status: normalized.status,
          validation: saved.validation.status,
        }),
      }
    } catch (failure) {
      const code = taskFailureCode(failure)
      if (code === "ACCESS_REVOKED") throw failure
      if (context.signal.aborted) throw failure
      return saveFailure(failure)
    }
  }
}

export function createBidRequirementsExecutor(dependencies: BidRequirementsExecutorDependencies): TaskExecutor {
  const env = dependencies.env ?? process.env
  const now = () => dependencies.now?.() ?? new Date()
  return async (job, context) => {
    if (job.kind !== "bid-requirements") return failed("INVALID_SUBMISSION")
    const identity = dependencies.identityFor(job.owner)
    const authorize = identityAuthorizer(dependencies, job.owner, identity)
    let blocked: unknown
    try {
      await context.refreshAccess()
      const loaded = await loadBidRequirementsInput(job, {
        repository: dependencies.repository,
        readProjectRetention: dependencies.readProjectRetention,
        refreshAccess: context.refreshAccess,
        now: dependencies.now,
      })
      // Recheck authorization/retention before every model call, not only once at
      // load: the paid request must never follow a revocation or expiry.
      const revalidateRetention = async (): Promise<void> => {
        const current = now()
        const projectRetention = await dependencies.readProjectRetention(job.projectId)
        if (!projectRetention) throw new VerificationError("INVALID_SOURCE")
        if (retentionExpired(projectRetention, current)) throw new VerificationError("RETENTION_EXPIRED")
        for (const material of loaded.materials) {
          const record = await dependencies.repository.findMaterial(job.projectId, material.materialId)
          if (!record || record.status !== "active" || !record.processingAuthorized) throw new VerificationError("INVALID_SOURCE")
          if (retentionExpired(record.retentionUntil, current)) throw new VerificationError("RETENTION_EXPIRED")
        }
      }
      await context.refreshAccess()
      const remainingCalls = job.maxCalls - job.callsUsed
      if (remainingCalls <= 0) return failed("BUDGET_EXHAUSTED")
      const callStarted = new Map<number, number>()
      let raw: unknown
      try {
        raw = await dependencies.extractor({
          paragraphs: loaded.paragraphs,
          complete: loaded.complete,
          ...(loaded.asOf ? { asOf: loaded.asOf } : {}),
          maxCalls: remainingCalls,
          signal: context.signal,
          env,
          onBeforeCall: async reservation => {
            try {
              await context.refreshAccess()
              await revalidateRetention()
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
            await context.settleCall(job.callsUsed + local, { timeMs: Math.max(0, Date.now() - started), costFen: null })
          },
        })
      } catch (failure) {
        blocked ??= failure
      }
      if (blocked) return blockedFailure(blocked)
      context.signal.throwIfAborted()
      let mapping
      try {
        mapping = parseRequirementCandidates(raw, loaded.paragraphs)
      } catch { return failed("EXTRACTOR_FAILED") }
      if (!mapping.requirements.length) return failed("NO_REQUIREMENTS")
      const fragmentTexts = new Map(loaded.paragraphs.map(paragraph => [paragraph.fragmentId, paragraph.text]))
      const sources: ResultSource[] = []
      const seenSources = new Set<string>()
      for (const requirement of mapping.requirements) {
        const fragmentText = fragmentTexts.get(requirement.source.fragmentId)
        if (fragmentText === undefined) return failed("INVALID_SOURCE")
        const key = `${requirement.source.snapshotId}:${requirement.source.fragmentId}`
        if (seenSources.has(key)) continue
        seenSources.add(key)
        sources.push({ fragmentId: requirement.source.fragmentId, snapshotId: requirement.source.snapshotId, quote: fragmentText })
      }
      const value: RequirementSetValue = {
        schemaVersion: 1,
        status: "candidate",
        requirements: mapping.requirements,
        rejected: mapping.rejected,
        warnings: [
          ...mapping.warnings,
          // Spec 01 §6.1/§7.2: a partial parse must never look like a full
          // "全面资格要求" check; keep the candidate result partial and say so.
          ...(loaded.complete ? [] : [PARTIAL_COVERAGE_WARNING]),
        ],
        errors: [],
      }
      let normalized: RequirementSetValue
      try { normalized = JSON.parse(JSON.stringify(value)) as RequirementSetValue } catch { return failed("RESULT_MISMATCH") }
      await context.refreshAccess()
      const saved = await dependencies.results.saveResultRevision(identity, authorize, {
        projectId: job.projectId,
        kind: "bid-requirements",
        baseVersionId: "",
        operationId: `bid-requirements:${job.id}:${job.attempt}`,
        reason: "投标要求候选机器成果（待人工确认）",
        value: normalized,
        sources,
        dependencies: dependencyList(loaded.materials),
      }, {
        output: normalized,
        taskId: job.id,
        attempt: job.attempt,
        executionToken: job.token,
      })
      if (saved.validation.status === "invalid") return failed("RESULT_INVALID")
      return {
        outcome: "success",
        resultSummary: JSON.stringify({
          resultId: saved.resultId,
          versionId: saved.versionId,
          sha256: saved.sha256,
          candidates: normalized.requirements.length,
          rejected: normalized.rejected.length,
          validation: saved.validation.status,
        }),
      }
    } catch (failure) {
      const code = taskFailureCode(failure)
      if (code === "ACCESS_REVOKED") throw failure
      if (context.signal.aborted) throw failure
      return saveFailure(failure)
    }
  }
}

/** Re-exported so callers can type an injected compare result without importing the engine. */
export type { CompareInput, CompareOutput, ExternalRecordSnapshot, RequirementSnapshot }
