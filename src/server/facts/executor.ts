import { randomUUID } from "node:crypto"
import { quotesMatch } from "@/lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import type { ProjectAction, ProjectExecutionAccess } from "@/lib/business/contracts"
import { isBusinessError, BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultService, ResultSource } from "../results/service"
import { estimateTaskCall } from "../tasks/estimates"
import type { TaskExecutor } from "../tasks/runner-core"
import { retentionExpired } from "../reviews/input"
import type { FactExtractor } from "./extractor"
import { loadFactsInput, type FactsInputDependencies, type FactsInput } from "./input"
import { factCandidateSchema, factCandidatesValidator, type FactCandidatesValue } from "./result-validator"

export type FactsExecutorDependencies = Omit<FactsInputDependencies, "refreshAccess"> & {
  results: Pick<ResultService, "saveResultRevision">; extractor: FactExtractor
  identityFor(accountId: string): AuthIdentity
  authorize(input: { accountId: string; projectId: string; action: ProjectAction }): Promise<ProjectExecutionAccess>
  env?: Record<string, string | undefined>
}
export function mapFactCandidates(raw: unknown, loaded: FactsInput): Pick<FactCandidatesValue, "candidates" | "rejected"> {
  const candidates: FactCandidatesValue["candidates"] = [], rejected: FactCandidatesValue["rejected"] = []
  const items = (raw as { candidates?: unknown[] } | null)?.candidates
  if (!Array.isArray(items) || items.length > 100) throw new BusinessError("INVALID_SOURCE", "事实候选结构无效。")
  for (const item of items) {
    const parsed = factCandidateSchema.omit({ candidateId: true }).safeParse(item)
    if (!parsed.success) { rejected.push({ reason: "候选字段结构无效。" }); continue }
    const fact = parsed.data
    if (fact.sources.some(source => !loaded.paragraphs.some(paragraph => paragraph.snapshotId === source.snapshotId && paragraph.fragmentId === source.fragmentId && quotesMatch(paragraph.text, source.quote)))) {
      rejected.push({ quote: fact.sources[0]?.quote, reason: "候选引文不能定位于所选材料快照。" }); continue
    }
    if (fact.periodStart && fact.periodEnd && fact.periodStart > fact.periodEnd) { rejected.push({ reason: "候选统计期间无效。" }); continue }
    candidates.push({ ...fact, candidateId: randomUUID() })
  }
  return { candidates, rejected }
}

export function createFactsExecutor(deps: FactsExecutorDependencies): TaskExecutor {
  return async (job, context) => {
    const failed = (errorCode: string, errorMessage: string) => ({ outcome: "failed" as const, errorCode, errorMessage })
    try {
      const loaded = await loadFactsInput(job, { ...deps, refreshAccess: context.refreshAccess })
      const remaining = job.maxCalls - job.callsUsed
      if (remaining <= 0) return failed("BUDGET_EXHAUSTED", "事实准备调用预算已用尽。")
      const refresh = async () => {
        await context.refreshAccess()
        const now = deps.now?.() ?? new Date()
        const retention = await deps.readProjectRetention(job.projectId)
        if (!retention || retentionExpired(retention, now)) throw new BusinessError("INVALID_SOURCE", "项目保留期限已到期。")
        for (const material of loaded.materials) {
          const record = await deps.repository.findMaterial(job.projectId, material.materialId)
          if (!record || record.status !== "active" || !record.processingAuthorized || retentionExpired(record.retentionUntil, now)) throw new BusinessError("INVALID_SOURCE", "材料授权或保留期限已变化。")
        }
      }
      const started = new Map<number, number>()
      const raw = await deps.extractor({ ...loaded, maxCalls: remaining, env: deps.env ?? process.env, signal: context.signal,
        onBeforeCall: async call => {
          await refresh()
          if (!Number.isInteger(call) || call < 1 || call > remaining) throw new BusinessError("BUDGET_EXHAUSTED", "事实准备调用预算已用尽。")
          await context.reserveCall(job.callsUsed + call, estimateTaskCall(job.kind, job.callsUsed + call))
          started.set(call, Date.now())
        },
        onExchange: async call => { const began = started.get(call); if (began !== undefined) { started.delete(call); await context.settleCall(job.callsUsed + call, { timeMs: Date.now() - began, costFen: null }) } },
      })
      context.signal.throwIfAborted()
      const mapped = mapFactCandidates(raw, loaded)
      if (!mapped.candidates.length) return { ...failed("NO_FACT_CANDIDATES", "未形成有效事实候选，请核对材料和拒绝项。"), resultSummary: JSON.stringify({ rejected: mapped.rejected }) }
      const value: FactCandidatesValue = { schemaVersion: 1, ...(loaded.cutoff ? { cutoff: loaded.cutoff } : {}), materials: loaded.materials, complete: loaded.complete,
        ...mapped, warnings: loaded.complete ? [] : ["所选材料存在解析覆盖限制，候选仅来自已解析范围。"] }
      const validation = await factCandidatesValidator(value)
      if (validation.status === "invalid") return failed("FACT_CANDIDATES_INVALID", "事实候选校验失败。")
      const sources: ResultSource[] = value.candidates.flatMap(candidate => candidate.sources.map(source => ({ snapshotId: source.snapshotId, fragmentId: source.fragmentId, quote: source.quote })))
      await refresh()
      const identity = deps.identityFor(job.owner)
      const authorize: ResultAuthorizer = async (_identity, projectId, action) => ({ ...(await deps.authorize({ accountId: job.owner, projectId, action })), identity })
      const saved = await deps.results.saveResultRevision(identity, authorize, { projectId: job.projectId, kind: "fact-candidates", baseVersionId: "", operationId: `facts:${job.id}:${job.attempt}`, reason: "材料事实候选", value, sources,
        dependencies: loaded.materials.map(material => ({ kind: "material", id: material.materialId, versionId: material.materialVersionId })) },
      { output: value, taskId: job.id, attempt: job.attempt, executionToken: job.token })
      if (saved.validation.status === "invalid") return failed("FACT_CANDIDATES_INVALID", "事实候选来源校验失败。")
      return { outcome: validation.status === "partial" ? "partial" : "success", resultSummary: JSON.stringify({ resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256, candidates: value.candidates.length, rejected: value.rejected.length }) }
    } catch (failure) {
      if (context.signal.aborted || (failure as { code?: string }).code === "ACCESS_REVOKED") throw failure
      if (isBusinessError(failure)) {
        if (["FORBIDDEN", "UNAUTHENTICATED"].includes(failure.code)) throw Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })
        return failed(failure.code, failure.message)
      }
      throw failure
    }
  }
}
