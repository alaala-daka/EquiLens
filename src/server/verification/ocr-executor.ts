import { createHash } from "node:crypto"
import { isVerificationFieldKey } from "../../lib/business/verification-fields"
import type { MaterialRepository } from "../materials/repository"
import { inspectImage, IMAGE_MATERIAL_MESSAGE, ParseFailure, type ImageInspection } from "../materials/parse"
import { isBusinessError } from "../projects/errors"
import { retentionExpired } from "../reviews/input"
import type { PrivateObjectStore } from "../storage/obs"
import { parseTaskRequest } from "../tasks/catalog"
import { estimateTaskCall } from "../tasks/estimates"
import { registerTaskAdmission, type TaskAdmission } from "../tasks/admission"
import { registerTaskExecutor } from "../tasks/executors"
import { TaskError } from "../tasks/errors"
import type { TaskExecutionResult, TaskExecutor } from "../tasks/runner-core"
import { isOcrError, OcrError, type OcrAdapter, type OcrExtractedField } from "./ocr"
import type { FieldWrite, OcrRepository } from "./ocr-repository"

/**
 * C4-OCR `certificate-ocr` executor.
 *
 * Bounded, honest certificate OCR inside the unified task runner:
 *  - exactly one image material version per task (catalogue + executor check);
 *  - ownership / stored-object digest / active status / retention are re-read
 *    before every paid request, and authorization is refreshed through the
 *    runner context before each call (a revoked account, removed member, stale
 *    attempt token or expired retention never reaches the provider);
 *  - at most two provider requests per task, counted from the persistent task
 *    ledger (`job.callsUsed`) and reserved through the shared budget ledger
 *    before the request; a failed reservation means zero external calls;
 *  - every attempt leaves a truthful `equilens_ocr_runs` row (running ->
 *    succeeded/partial/failed/unavailable) and only a successful or partial
 *    extraction writes insert-only field history; failures write no fields and
 *    no demo values.
 *
 * The adapter is injected: production wiring passes the fail-closed adapter
 * from `ocr.ts`, tests pass the synthetic fixture so no external request is
 * made by the test suite.
 */

const criticalFieldKeys = ["subject_name", "holder_name", "certificate_number"] as const
const lowConfidence = 60

export type CertificateOcrExecutorDependencies = {
  adapter: OcrAdapter
  repository: Pick<MaterialRepository, "versionById" | "findMaterial">
  ocr: Pick<OcrRepository, "beginRun" | "finishRun" | "completeRun">
  store: Pick<PrivateObjectStore, "get">
  /** Trusted server resolver; null means the project is missing or no longer active. */
  readProjectRetention: (projectId: string) => Promise<string | null>
  /** Hard ceiling for one provider request (measured failures stay truthful). */
  requestTimeoutMs?: number
  now?: () => Date
}

class OcrExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "OcrExecutionError"
  }
}

const failed = (errorCode: string, errorMessage: string): TaskExecutionResult => ({ outcome: "failed", errorCode, errorMessage })

function failureCode(failure: unknown): string | undefined {
  const value = failure as { code?: unknown } | null
  return value && typeof value.code === "string" ? value.code : undefined
}

const cancelled = (): Error => Object.assign(new Error("任务已取消。"), { code: "CANCELLED" })

/**
 * Bound one provider request by the per-request timeout and the runner abort
 * signal. The adapter also receives the signal, but this race guarantees the
 * serial runner can never hang on an adapter that ignores it.
 */
function recognizeWithAbort<T>(work: Promise<T>, signal: AbortSignal, timeout: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const remove = () => { signal.removeEventListener("abort", onCancel); timeout.removeEventListener("abort", onTimeout) }
    const finish = (settle: () => void) => { if (settled) return; settled = true; remove(); settle() }
    const onCancel = () => finish(() => reject(cancelled()))
    const onTimeout = () => finish(() => reject(new OcrError("OCR_TIMEOUT", "OCR 请求超时。")))
    signal.addEventListener("abort", onCancel, { once: true })
    timeout.addEventListener("abort", onTimeout, { once: true })
    work.then(value => finish(() => resolve(value)), failure => finish(() => reject(failure)))
    if (signal.aborted) onCancel()
    else if (timeout.aborted) onTimeout()
  })
}

/**
 * Certificate kinds may be configured as identifiers (`enterprise_license`) or
 * Chinese display names (`营业执照`); both must resolve to the same subject
 * group. The adapter allowlist remains exact-match on `supportedKinds()`; only
 * the field subject identity is normalized here.
 *
 * Fail closed: a kind measured by a future adapter but not in this explicit map
 * has NO subject group. The executor refuses it before any provider call, so a
 * person certificate can never be mislabelled as an enterprise subject (which
 * could make a mixed-subject requirement appear satisfied).
 */
const enterpriseKindAliases = new Set([
  "enterprise_license", "business_license", "enterprise_qualification", "enterprise_certificate",
  "营业执照", "企业营业执照", "建筑业企业资质证书", "建筑业企业资质", "企业资质证书", "企业资质", "资质证书",
  "安全生产许可证", "许可证",
])
const personKindAliases = new Set([
  "person_certificate", "personnel_certificate", "person_qualification", "personnel_qualification",
  "人员资格证书", "人员资格", "人员证书", "个人资格证书", "个人证书", "注册建造师", "建造师证书", "建造师",
  "执业资格证书", "职称证书",
])

function normalizedCertificateKind(certificateKind: string): string {
  return certificateKind.normalize("NFKC").trim().toLowerCase().replace(/[\s./\\-]+/g, "_")
}

/** Explicit subject mapping; null means "not mappable" and must fail closed. */
function subjectKeyFor(certificateKind: string): "enterprise" | "person" | null {
  const normalized = normalizedCertificateKind(certificateKind)
  if (personKindAliases.has(normalized)) return "person"
  if (enterpriseKindAliases.has(normalized)) return "enterprise"
  return null
}

function fieldDigits(value: string): string {
  return value.replace(/\D/g, "")
}

/** Keep the first occurrence of every vocabulary field; drop malformed provider output. */
function sanitizeFields(fields: unknown): OcrExtractedField[] {
  if (!Array.isArray(fields)) return []
  const seen = new Set<string>()
  const result: OcrExtractedField[] = []
  for (const raw of fields) {
    if (!raw || typeof raw !== "object") continue
    const candidate = raw as Partial<OcrExtractedField>
    if (!isVerificationFieldKey(candidate.fieldKey)) continue
    if (typeof candidate.valueText !== "string") continue
    const valueText = candidate.valueText.trim()
    if (!valueText || valueText.length > 2000) continue
    if (seen.has(candidate.fieldKey)) continue
    const confidence = candidate.confidence === undefined || candidate.confidence === null ? null : candidate.confidence
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) continue
    seen.add(candidate.fieldKey)
    result.push({
      fieldKey: candidate.fieldKey,
      valueText,
      confidence: confidence as number | null,
      ...(candidate.box && typeof candidate.box === "object" ? { box: candidate.box } : {}),
    })
  }
  return result
}

/** A run is partial when a critical field is absent or recognized with low confidence. */
function extractionQuality(fields: readonly OcrExtractedField[], subjectKey: "enterprise" | "person"): "succeeded" | "partial" {
  const present = new Set(fields.map(field => field.fieldKey))
  const subjectField = subjectKey === "enterprise" ? "subject_name" : "holder_name"
  if (!present.has(subjectField) || !present.has("certificate_number")) return "partial"
  for (const field of fields) {
    if (criticalFieldKeys.includes(field.fieldKey as (typeof criticalFieldKeys)[number]) && field.confidence !== null && field.confidence < lowConfidence) return "partial"
  }
  return "succeeded"
}

/**
 * Create the `certificate-ocr` TaskExecutor. Production registers it through
 * `startOcrRuntime()`; the executor itself never registers or starts anything.
 */
export function createCertificateOcrExecutor(dependencies: CertificateOcrExecutorDependencies): TaskExecutor {
  const now = () => dependencies.now?.() ?? new Date()
  return async (job, context) => {
    if (job.kind !== "certificate-ocr") return failed("INVALID_SUBMISSION", "任务类型不匹配。")
    let parsed: ReturnType<typeof parseTaskRequest>
    try {
      parsed = parseTaskRequest({ kind: job.kind, projectId: job.projectId, refs: job.manifest.refs, conditions: job.manifest.conditions })
    } catch {
      return failed("INVALID_SUBMISSION", "证照 OCR 任务输入无效。")
    }
    const refs = (parsed.refs as { materials?: unknown }).materials
    if (!Array.isArray(refs) || refs.length !== 1) return failed("INVALID_SUBMISSION", "证照 OCR 任务必须恰好包含 1 个材料版本。")
    const ref = refs[0] as { materialVersionId: string; sha256: string }
    const certificateKind = typeof parsed.conditions.certificateKind === "string" ? parsed.conditions.certificateKind.trim() : ""
    if (!certificateKind) return failed("INVALID_SUBMISSION", "证照种类无效。")

    let runId: string | null = null
    let callsUsed = job.callsUsed
    let provider: string | null = null
    let providerVersion: string | null = null
    let requestId: string | null = null
    let usageJson: string | null = null
    let imageJson: string | null = null
    let materialId = ""
    let versionId = ""
    const finish = async (state: "succeeded" | "partial" | "failed" | "unavailable", errorCode: string | null): Promise<void> => {
      if (!runId) return
      try {
        await dependencies.ocr.finishRun({
          projectId: job.projectId, id: runId, state, callsUsed,
          provider, providerVersion, requestId, usageJson, imageJson, errorCode,
          finishedAt: now().toISOString(),
        })
      } catch {
        // A failed run-record transition must not fake success or overwrite a
        // finished run; the task failure below remains truthful either way.
      }
    }

    try {
      await context.refreshAccess()
      if (!dependencies.adapter.available()) {
        // Truthful failed run when the capability is gone at execution time.
        const version = await dependencies.repository.versionById(job.projectId, ref.materialVersionId).catch(() => null)
        if (version) {
          materialId = version.materialId
          versionId = version.id
          const run = await dependencies.ocr.beginRun({ projectId: job.projectId, materialId, versionId, certificateKind, createdBy: job.owner, startedAt: now().toISOString() })
          runId = run.id
        }
        await finish("unavailable", "OCR_UNAVAILABLE")
        return failed("OCR_UNAVAILABLE", "OCR 服务尚未验证，当前不可用。")
      }
      const supported = dependencies.adapter.supportedKinds()
      if (!supported.includes(certificateKind)) return failed("OCR_KIND_NOT_SUPPORTED", "证照种类未通过实测，不能执行 OCR。")
      // An allowlisted kind must also have an explicit subject mapping: an adapter
      // that measures a new identifier without being added here is refused before
      // any material read or provider call, so fields can never be mislabelled
      // into the wrong subject group.
      const subjectKey = subjectKeyFor(certificateKind)
      if (!subjectKey) return failed("OCR_KIND_NOT_SUPPORTED", "证照种类没有明确的主体映射，不能执行 OCR。")

      const version = await dependencies.repository.versionById(job.projectId, ref.materialVersionId)
      if (!version || version.sha256 !== ref.sha256) return failed("INVALID_SOURCE", "材料版本不存在或摘要不符。")
      const material = await dependencies.repository.findMaterial(job.projectId, version.materialId)
      if (!material || material.status !== "active" || !material.processingAuthorized) return failed("INVALID_SOURCE", "材料不存在、已失效或未授权处理。")
      if (material.format !== "image") return failed("INVALID_SOURCE", "证照 OCR 只接受图片材料版本。")
      materialId = material.id
      versionId = version.id
      const run = await dependencies.ocr.beginRun({ projectId: job.projectId, materialId, versionId, certificateKind, createdBy: job.owner, startedAt: now().toISOString(), callsUsed })
      runId = run.id
      // Persistent per-task call ceiling (maxCalls = 2): a recovered attempt that
      // already used both requests never issues a third one.
      if (job.callsUsed >= job.maxCalls) {
        await finish("failed", "OCR_BUDGET_EXHAUSTED")
        return failed("OCR_BUDGET_EXHAUSTED", "该证照 OCR 任务已用完最多 2 次请求，请新建任务并确认重新消耗资源。")
      }

      // Re-read authorization, provenance and retention before the stored image is read.
      const revalidate = async (): Promise<void> => {
        await context.refreshAccess()
        const current = now()
        const projectRetention = await dependencies.readProjectRetention(job.projectId)
        if (!projectRetention) throw new OcrExecutionError("INVALID_SOURCE", "项目不存在或已删除。")
        if (retentionExpired(projectRetention, current)) throw new OcrExecutionError("RETENTION_EXPIRED", "材料保留期已到期，未调用 OCR。")
        const latest = await dependencies.repository.findMaterial(job.projectId, material.id)
        if (!latest || latest.status !== "active" || !latest.processingAuthorized) throw new OcrExecutionError("INVALID_SOURCE", "材料已失效。")
        if (retentionExpired(latest.retentionUntil, current)) throw new OcrExecutionError("RETENTION_EXPIRED", "材料保留期已到期，未调用 OCR。")
      }
      await revalidate()
      context.signal.throwIfAborted()

      const object = await dependencies.store.get(version.objectKey)
      if (!object || object.sha256 !== version.sha256 || object.bytes.byteLength !== version.size ||
        createHash("sha256").update(object.bytes).digest("hex") !== ref.sha256) {
        throw new OcrExecutionError("INVALID_SOURCE", "材料原件校验失败，未调用 OCR。")
      }
      let inspection: ImageInspection
      try {
        const found = inspectImage(object.bytes)
        if (!found) throw new ParseFailure("INVALID_SOURCE", IMAGE_MATERIAL_MESSAGE)
        if (found.width > 8192 || found.height > 8192 || found.width * found.height > 40_000_000) throw new ParseFailure("LIMIT_EXCEEDED", IMAGE_MATERIAL_MESSAGE)
        inspection = found
      } catch (failure) {
        if (failure instanceof ParseFailure) throw new OcrExecutionError(failure.code === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED" : "INVALID_SOURCE", failure.message)
        throw failure
      }

      const maxLocalCalls = Math.min(2, job.maxCalls)
      const requestTimeoutMs = dependencies.requestTimeoutMs ?? 90_000
      let extraction: Awaited<ReturnType<OcrAdapter["recognize"]>> | null = null
      let lastError: string | null = null
      for (let localCall = 1; localCall <= maxLocalCalls; localCall++) {
        const globalCall = job.callsUsed + localCall
        if (globalCall > job.maxCalls) break
        await revalidate()
        context.signal.throwIfAborted()
        await context.reserveCall(globalCall, estimateTaskCall(job.kind, globalCall))
        callsUsed = globalCall
        const startedAt = Date.now()
        // One request must not hang the serial runner: the adapter observes an
        // abort signal that fires on the runner abort or on the per-request timeout.
        const requestTimeout = AbortSignal.timeout(requestTimeoutMs)
        try {
          extraction = await recognizeWithAbort(dependencies.adapter.recognize({
            projectId: job.projectId, materialId: material.id, versionId: version.id,
            certificateKind, bytes: object.bytes, contentType: version.contentType, sha256: version.sha256,
            signal: AbortSignal.any([context.signal, requestTimeout]),
          }), context.signal, requestTimeout)
        } catch (failure) {
          if (context.signal.aborted) throw failure
          const code = failure instanceof OcrError && failure.code === "OCR_TIMEOUT"
            ? "OCR_TIMEOUT"
            : isOcrError(failure) ? failure.code : "OCR_FAILED"
          lastError = code
          await context.settleCall(globalCall, { timeMs: Math.max(0, Date.now() - startedAt), costFen: null })
          if (code === "OCR_UNAVAILABLE") throw new OcrExecutionError("OCR_UNAVAILABLE", "OCR 服务当前不可用。")
          continue
        }
        // Cost/time known from the provider response; no hidden per-call charge.
        await context.settleCall(globalCall, {
          timeMs: Math.max(0, Date.now() - startedAt),
          costFen: extraction.usage.costFen ?? null,
        })
        const sanitized = sanitizeFields(extraction.fields)
        if (!sanitized.length && extraction.text === null) {
          lastError = "OCR_NO_TEXT"
          extraction = null
          continue
        }
        provider = typeof extraction.provider === "string" ? extraction.provider.slice(0, 64) : null
        providerVersion = typeof extraction.providerVersion === "string" ? extraction.providerVersion.slice(0, 64) : null
        requestId = typeof extraction.requestId === "string" ? extraction.requestId.slice(0, 128) : null
        usageJson = JSON.stringify({ calls: localCall, costFen: extraction.usage.costFen, timeMs: extraction.usage.timeMs })
        imageJson = JSON.stringify({ ...inspection, provider: extraction.image })
        const state = extractionQuality(sanitized, subjectKey)
        const writes: FieldWrite[] = sanitized.map(field => ({
          projectId: job.projectId, materialId: material.id, versionId: version.id, subjectKey,
          fieldKey: field.fieldKey, valueText: field.valueText, origin: "ocr",
          sourceSnapshotId: null, sourceFragmentId: null, ocrRunId: runId,
          confidence: field.confidence, boxJson: field.box ? JSON.stringify(field.box) : null,
          reason: null, createdBy: job.owner,
          idempotencyKey: `ocr:${runId}:${subjectKey}:${field.fieldKey}`,
        }))
        // Field rows are a material-derived write: recheck access, authorization,
        // material activity and retention again immediately before INSERT.
        await revalidate()
        context.signal.throwIfAborted()
        try {
          // Fields and the terminal run state are written in one transaction.
          await dependencies.ocr.completeRun({
            projectId: job.projectId, id: runId, state, callsUsed, fields: writes,
            provider, providerVersion, requestId, usageJson, imageJson, errorCode: null,
            finishedAt: now().toISOString(),
          })
        } catch {
          await finish("failed", "OCR_FIELD_WRITE_FAILED")
          return failed("OCR_FIELD_WRITE_FAILED", "OCR 字段保存失败，任务已停止。")
        }
        return {
          outcome: state === "succeeded" ? "success" : "partial",
          resultSummary: JSON.stringify({ runId, state, fields: writes.length, subjectKey }),
        }
      }
      await finish("failed", lastError ?? "OCR_FAILED")
      return failed(lastError ?? "OCR_FAILED", lastError === "OCR_NO_TEXT"
        ? "OCR 未产出可用文字或字段，任务已停止；未写入任何字段。"
        : "OCR 请求失败，任务已停止；未写入任何字段。")
    } catch (failure) {
      const code = failureCode(failure)
      if (code === "ACCESS_REVOKED") { await finish("failed", "ACCESS_REVOKED"); throw failure }
      if (context.signal.aborted) { await finish("failed", "CANCELLED"); throw failure }
      if (failure instanceof OcrExecutionError) { await finish("failed", failure.code); return failed(failure.code, failure.message) }
      if (isBusinessError(failure)) {
        if (failure.code === "BUDGET_EXHAUSTED") { await finish("failed", "OCR_BUDGET_EXHAUSTED"); return failed("OCR_BUDGET_EXHAUSTED", "任务预算不足，未发起 OCR 请求。") }
        if (failure.code === "CONFLICT") { await finish("failed", "CONFLICT"); return failed("CONFLICT", "任务或字段状态已变化。") }
        if (failure.code === "SERVICE_UNAVAILABLE") { await finish("failed", "SERVICE_UNAVAILABLE"); return failed("SERVICE_UNAVAILABLE", "OCR 服务暂不可用。") }
        await finish("failed", failure.code)
        return failed(failure.code, "OCR 执行失败，任务已停止。")
      }
      await finish("failed", "OCR_FAILED")
      return failed("OCR_FAILED", "OCR 执行失败，任务已停止；未写入演示结果。")
    }
  }
}

export { subjectKeyFor as certificateSubjectKey, sanitizeFields as sanitizeOcrFields, extractionQuality as ocrExtractionQuality, criticalFieldKeys, lowConfidence, fieldDigits }

/**
 * Kind-level admission for `certificate-ocr` (runs before a task is persisted).
 *
 * Unavailable adapter -> 503; a certificate kind outside the measured
 * `supportedKinds()` allowlist -> 422. Both leave no queued task behind.
 */
export function certificateOcrAdmission(adapter: OcrAdapter): TaskAdmission {
  return async input => {
    if (!adapter.available()) throw new TaskError(503, "SERVICE_UNAVAILABLE", "该任务类型尚未开放。")
    const certificateKind = input.conditions.certificateKind
    if (typeof certificateKind !== "string" || !adapter.supportedKinds().includes(certificateKind)) {
      throw new TaskError(422, "INVALID_SUBMISSION", "证照种类尚未通过实测，不能提交 OCR 任务。")
    }
  }
}

/**
 * Register the certificate-ocr capability from an explicit lifecycle only:
 * the admission hook is always registered, and the executor exists only when
 * the adapter is available AND at least one certificate kind was measured.
 * Returns whether the executor was registered.
 */
export function registerCertificateOcrCapability(adapter: OcrAdapter, createExecutor: (adapter: OcrAdapter) => TaskExecutor): boolean {
  registerTaskAdmission("certificate-ocr", certificateOcrAdmission(adapter))
  if (!adapter.available() || adapter.supportedKinds().length === 0) return false
  registerTaskExecutor("certificate-ocr", createExecutor(adapter))
  return true
}
