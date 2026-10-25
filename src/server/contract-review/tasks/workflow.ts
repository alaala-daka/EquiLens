import { createHash, randomUUID } from "node:crypto"
import { readDocxInChild } from "../../../../tools/contract-review/src/document"
import { reviewWithAgent } from "../../../../tools/contract-review/src/agent"
import { reviewWithAgents } from "../../../../tools/contract-review/src/agent/pipeline"
import type { AgentProgress } from "../../../../tools/contract-review/src/agent"
import { ReviewError, safeError } from "../../../../tools/contract-review/src/errors"
import type { ReviewTask, ReviewResult } from "../../../lib/contract-reviews/types"
import type { ClaimedReview, ReviewTaskRepository } from "./repository"

/**
 * 执行一次已领取的审查任务。
 * 本模块不引用 server-only，便于行为测试直接注入仓储与模型传输；生产入口仍是 runner.ts。
 */
export type RunnerOverrides = {
  repository?: ReviewTaskRepository
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  /** 供调用方登记/释放当前执行，用于取消；生产路径由 runner 提供。 */
  onActive?: (controller: AbortController | null) => void
}

const retryable = (code?: string) => ["AI_NETWORK_ERROR", "AI_TIMEOUT", "AI_UPSTREAM_ERROR"].includes(code ?? "")

export async function runClaimedReview(job: ClaimedReview, overrides: RunnerOverrides = {}) {
  const repository = overrides.repository ?? await (await import("./service")).reviewTaskRepository()
  const controller = new AbortController()
  overrides.onActive?.(controller)
  const elapsed = () => Math.min(600000, job.elapsedMs + Date.now() - Date.parse(job.startedAt))
  const timeout = setTimeout(() => controller.abort(new ReviewError("REVIEW_TIMEOUT")), Math.max(1, 600000 - elapsed()))
  let heartbeatBusy = false
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return
    heartbeatBusy = true
    void repository.heartbeat(job, elapsed()).catch(() => controller.abort(new ReviewError("REVIEW_RESERVATION_FAILED")))
      .finally(() => { heartbeatBusy = false })
  }, 15000)
  heartbeat.unref()
  let progress: ReviewTask["progress"] = { readParagraphCount: 0, paragraphCount: job.snapshot?.paragraphs.length ?? 0, submittedRuleCount: 0 }
  let stage = "parsing"
  let result: ReviewResult | null = null
  try {
    controller.signal.throwIfAborted()
    if (!job.snapshot) {
      await repository.checkpoint(job, stage, progress, null, elapsed())
      const revision = await repository.readRevision(job.owner, job.input.documentId, job.input.revisionId, job.input.documentContextId)
      if (revision.hash !== job.input.revisionHash) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
      const paragraphs = await readDocxInChild(revision.bytes, controller.signal)
      controller.signal.throwIfAborted()
      job.snapshot = { id: randomUUID(), paragraphs, complete: true,
        textSha256: createHash("sha256").update(paragraphs.map(item => item.text).join("\n")).digest("hex") }
      await repository.snapshot(job, job.snapshot)
    }
    const snapshot = job.snapshot
    progress.paragraphCount = snapshot.paragraphs.length
    const settings = {
      paragraphs: snapshot.paragraphs, complete: snapshot.complete,
      documentTitle: job.input.title, documentVersionId: job.input.revisionId, parseSnapshotId: snapshot.id,
      context: job.input.context, mode: job.input.mode, signal: controller.signal,
      callsUsed: job.callsUsed, maxCalls: job.maxCalls, timeoutMs: Math.max(1, 600000 - elapsed()), maxPromptChars: job.input.maxPromptChars,
      previousResult: job.checkpoint ?? undefined,
      env: overrides.env ?? { AI_BASE_URL: job.input.baseURL, AI_MODEL: job.input.model, AI_API_KEY: process.env.AI_API_KEY },
      fetcher: overrides.fetcher,
      onBeforeCall: async (reservation: { callNumber: number; ruleIds: string[] }) => {
        controller.signal.throwIfAborted()
        await repository.reserve(job, reservation.callNumber, elapsed())
        job.callsUsed = reservation.callNumber
        controller.signal.throwIfAborted()
      },
      onProgress: (value: AgentProgress) => {
        stage = value.stage === "completed" ? "validating" : value.stage
        progress = { readParagraphCount: value.readParagraphCount, paragraphCount: value.paragraphCount, submittedRuleCount: value.submittedRuleCount,
          ...(value.agentRole ? { agentRole: value.agentRole, auditedRuleCount: value.auditedRuleCount ?? 0 } : {}) }
      },
      onCheckpoint: (checkpoint: ReviewResult) => repository.checkpoint(job, stage, progress, checkpoint, elapsed()),
      onModelExchange: (exchange: { callNumber: number; request: unknown; response: unknown; agentRole?: string }) => repository.artifact(job, "model-exchange", exchange.callNumber, exchange),
    }
    if (job.input.workflow === "multi-agent-v1") {
      if (!job.input.sceneBundles?.length) throw new ReviewError("REVIEW_SCENE_INVALID")
      result = await reviewWithAgents({ ...settings, bundles: job.input.sceneBundles, auditEffort: job.input.auditEffort })
    } else result = await reviewWithAgent({ ...settings, pack: job.input.pack, skill: job.input.skill, sceneCandidates: job.input.sceneCandidates })
    controller.signal.throwIfAborted()
    const error = result.errors[0] ?? null
    const retry = retryable(error?.code) && job.attempt < 2 && job.callsUsed < job.maxCalls && elapsed() < 600000
    await repository.finish(job, result, error, elapsed(), retry)
  } catch (failure) {
    const error = safeError(controller.signal.aborted ? controller.signal.reason : failure)
    const retry = retryable(error.code) && job.attempt < 2 && job.callsUsed < job.maxCalls && elapsed() < 600000
    await repository.finish(job, result, error, elapsed(), retry).catch(() => {})
  } finally {
    clearInterval(heartbeat)
    clearTimeout(timeout)
    controller.abort(new ReviewError("REVIEW_CANCELLED"))
    overrides.onActive?.(null)
    await repository.release(job).catch(() => {})
  }
}
