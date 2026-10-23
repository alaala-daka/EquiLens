import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { readDocxInChild } from "../../../../tools/contract-review/src/document"
import { reviewWithAgent } from "../../../../tools/contract-review/src/agent"
import { ReviewError, safeError } from "../../../../tools/contract-review/src/errors"
import type { ReviewTask, ReviewResult } from "../../../lib/contract-reviews/types"
import { reviewTaskRepository } from "./service"
import type { ClaimedReview } from "./repository"

type Runner = { started: boolean; ticking: boolean; timer?: ReturnType<typeof setTimeout>; active?: { id: string; controller: AbortController }; work?: Promise<void> }
const global = globalThis as typeof globalThis & { equilensReviewRunner?: Runner }
function state(): Runner { return global.equilensReviewRunner ??= { started: false, ticking: false } }
const retryable = (code?: string) => ["AI_NETWORK_ERROR", "AI_TIMEOUT", "AI_UPSTREAM_ERROR"].includes(code ?? "")

async function execute(job: ClaimedReview) {
  const repository = await reviewTaskRepository()
  const controller = new AbortController()
  state().active = { id: job.id, controller }
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
      const revision = await repository.readRevision(job.owner, job.input.documentId, job.input.revisionId)
      if (revision.hash !== job.input.revisionHash) throw new ReviewError("REVIEW_DOCUMENT_INVALID")
      const paragraphs = await readDocxInChild(revision.bytes, controller.signal)
      controller.signal.throwIfAborted()
      job.snapshot = { id: randomUUID(), paragraphs, complete: true,
        textSha256: createHash("sha256").update(paragraphs.map(item => item.text).join("\n")).digest("hex") }
      await repository.snapshot(job, job.snapshot)
    }
    const snapshot = job.snapshot
    progress.paragraphCount = snapshot.paragraphs.length
    result = await reviewWithAgent({
      pack: job.input.pack, skill: job.input.skill, paragraphs: snapshot.paragraphs, complete: snapshot.complete,
      documentTitle: job.input.title, documentVersionId: job.input.revisionId, parseSnapshotId: snapshot.id,
      context: job.input.context, mode: job.input.mode, signal: controller.signal,
      callsUsed: job.callsUsed, maxCalls: job.maxCalls, timeoutMs: Math.max(1, 600000 - elapsed()), maxPromptChars: job.input.maxPromptChars,
      previousResult: job.checkpoint ?? undefined,
      env: { AI_BASE_URL: job.input.baseURL, AI_MODEL: job.input.model, AI_API_KEY: process.env.AI_API_KEY },
      onBeforeCall: async reservation => {
        controller.signal.throwIfAborted()
        await repository.reserve(job, reservation.callNumber, elapsed())
        job.callsUsed = reservation.callNumber
        controller.signal.throwIfAborted()
      },
      onProgress: value => {
        stage = value.stage === "completed" ? "validating" : value.stage
        progress = { readParagraphCount: value.readParagraphCount, paragraphCount: value.paragraphCount, submittedRuleCount: value.submittedRuleCount }
      },
      onCheckpoint: checkpoint => repository.checkpoint(job, stage, progress, checkpoint, elapsed()),
      onModelExchange: exchange => repository.artifact(job, "model-exchange", exchange.callNumber, exchange),
    })
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
    if (state().active?.id === job.id) state().active = undefined
    await repository.release(job).catch(() => {})
  }
}
async function tick() {
  const current = state()
  if (!current.started || current.ticking) return
  current.ticking = true
  try {
    const job = await (await reviewTaskRepository()).claim()
    if (job) await execute(job)
  } catch { console.error("Contract review task runner unavailable") }
  finally {
    current.ticking = false
    if (current.started) {
      current.timer = setTimeout(() => { current.work = tick() }, 2000)
      current.timer.unref()
    }
  }
}
/** 仅由 instrumentation 的 Node.js 生命周期显式调用。 */
export function startReviewRunner() {
  const current = state()
  if (current.started) return
  current.started = true
  current.work = tick()
}
export function wakeReviewRunner() {
  const current = state()
  if (!current.started || current.ticking) return
  clearTimeout(current.timer)
  current.work = tick()
}
export function cancelRunningReview(id: string) {
  if (state().active?.id === id) state().active?.controller.abort(new ReviewError("REVIEW_CANCELLED"))
}
export async function stopReviewRunner() {
  const current = state()
  current.started = false
  clearTimeout(current.timer)
  current.active?.controller.abort(new ReviewError("REVIEW_CANCELLED"))
  await current.work
}
