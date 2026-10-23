import { createHash, randomUUID } from "node:crypto"
import { paragraphsFromString } from "./document"
import { ReviewError, safeError } from "./errors"
import { applicability, matchRules } from "./match"
import { publishedRules, publishedSources } from "./pack"
import { buildPrompt } from "./prompt"
import type { LoadedPack, Paragraph, ReviewContext, ReviewResult, TriggeredRule } from "./types"
import { buildOutline, expandSegments, type Segment } from "./segments"
import { buildCoverage, validateFindings, type RawFinding } from "./validate"

export type AskModel = (input: { system: string; user: string; signal?: AbortSignal }) =>
  Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null }>

export type ReviewOptions = {
  documentText?: string
  paragraphs?: Paragraph[]
  documentTitle?: string
  documentVersionId?: string
  parseSnapshotId?: string
  complete?: boolean
  context?: ReviewContext
  model: AskModel
  modelName?: string
  mode?: "published" | "debug"
  /** 兼容旧 CLI；新集成使用 mode。 */
  includeUnpublished?: boolean
  batchSize?: number
  maxPromptChars?: number
  maxCalls?: number
  /** 恢复时传入已占用次数；跨恢复预算由调用方保存。 */
  callsUsed?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 持久化计次并复查权限；失败时不会发送请求。 */
  onBeforeCall?: (reservation: { callNumber: number; ruleIds: string[] }) => Promise<void>
  /**
   * 条款块。提供后进入定向取材：每批只送相关块及相邻块，并附全文目录。
   * 不提供时保持原行为，整篇合同随每批发送。
   */
  segments?: Segment[]
}

export function parseModelOutput(text: string): RawFinding[] {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    const value: unknown = JSON.parse(cleaned)
    if (!value || typeof value !== "object" || !("findings" in value) || !Array.isArray(value.findings)) throw new Error()
    if (value.findings.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error()
    return value.findings as RawFinding[]
  } catch { throw new ReviewError("REVIEW_OUTPUT_INVALID") }
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((accept, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener("abort", abort)
    if (signal.aborted) { void work.catch(() => {}); reject(signal.reason); return }
    signal.addEventListener("abort", abort, { once: true })
    work.then(value => { cleanup(); accept(value) }, failure => { cleanup(); reject(failure) })
  })
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ReviewError("REVIEW_INPUT_INVALID")
  return value
}

export async function reviewContract(options: ReviewOptions & { pack: LoadedPack }): Promise<ReviewResult> {
  if ((options.complete !== undefined && typeof options.complete !== "boolean") ||
      (options.context !== undefined && (!options.context || typeof options.context !== "object" || Array.isArray(options.context))) ||
      [options.documentTitle, options.documentVersionId, options.parseSnapshotId].some(value =>
        value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 200))) throw new ReviewError("REVIEW_INPUT_INVALID")
  // 固定本次输入；调用方在等待模型时修改原对象不会改变引文校验范围。
  const pack = structuredClone(options.pack)
  if (options.documentText !== undefined && options.paragraphs !== undefined) throw new ReviewError("REVIEW_INPUT_INVALID")
  if (options.documentText !== undefined && typeof options.documentText !== "string") throw new ReviewError("REVIEW_INPUT_INVALID")
  const paragraphs = structuredClone(options.paragraphs ?? paragraphsFromString(options.documentText ?? ""))
  if (!paragraphs.length || paragraphs.some(item => !item || !Number.isSafeInteger(item.index) || item.index < 0 || typeof item.text !== "string" || !item.text.trim()) ||
      new Set(paragraphs.map(item => item.index)).size !== paragraphs.length) throw new ReviewError("REVIEW_INPUT_INVALID")
  const text = paragraphs.map(item => item.text).join("\n")
  if (text.length > 100000 || (options.documentText?.length ?? 0) > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
  const focus = options.segments?.length ? structuredClone(options.segments) : null
  if (focus) {
    const known = new Set(paragraphs.map(item => item.index))
    const invalid = focus.some(segment => !segment || !Array.isArray(segment.indexes) ||
      typeof segment.title !== "string" || !segment.indexes.length || segment.indexes.some(index => !known.has(index))) ||
      focus.flatMap(segment => segment.indexes).length !== known.size ||
      new Set(focus.flatMap(segment => segment.indexes)).size !== known.size
    if (invalid) throw new ReviewError("REVIEW_INPUT_INVALID")
  }
  const context = { ...options.context }
  if (Object.values(context).some(value => typeof value !== "string" || !value.trim() || value.length > 200)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const batchSize = integer(options.batchSize ?? 7, 1, 20)
  const maxCalls = integer(options.maxCalls ?? 3, 1, 3)
  const maxPromptChars = integer(options.maxPromptChars ?? 240000, 1000, 240000)
  const timeoutMs = integer(options.timeoutMs ?? 600000, 1, 600000)
  const mode = options.mode ?? (options.includeUnpublished ? "debug" : "published")
  if (mode !== "published" && mode !== "debug") throw new ReviewError("REVIEW_INPUT_INVALID")
  const result: ReviewResult = {
    schemaVersion: 1, reviewId: randomUUID(), createdAt: new Date().toISOString(),
    status: "failed", mode, warnings: [...pack.warnings], errors: [],
    input: {
      textSha256: createHash("sha256").update(text).digest("hex"),
      documentVersionId: options.documentVersionId, parseSnapshotId: options.parseSnapshotId,
      complete: options.complete !== false, context,
    },
    callsUsed: integer(options.callsUsed ?? 0, 0, 3),
    documentTitle: options.documentTitle ?? "未命名合同", packVersion: pack.manifest.version,
    paragraphs, findings: [], rejected: [], notLocated: [], coverage: [], usage: null, model: options.modelName ?? "未标注模型",
  }
  if (mode === "debug") result.warnings.unshift("调试结果：使用未核对材料，仅用于开发联调，不形成正式法律结论。")
  if (!result.input.complete) result.warnings.push("输入解析不完整；不能确认无问题或条款缺失。")
  const rules = pack.manifest.status === "已停用" ? [] : mode === "debug"
    ? pack.rules.filter(rule => rule.status !== "已停用") : publishedRules(pack)
  const sources = (mode === "debug" ? pack.sources.filter(source => source.status !== "已停用") : publishedSources(pack))
    .filter(source => source.text?.trim())
  const sourceIds = new Set(sources.map(source => source.sourceId))
  const planned: TriggeredRule[] = []
  const executable: TriggeredRule[] = []
  let excluded = 0
  for (const rule of rules) {
    const applies = applicability(rule, context)
    if (applies === "excluded") { excluded++; result.warnings.push(rule.ruleId + "：调用方确认的适用条件不符，本次排除。"); continue }
    const entry = matchRules([{ ...rule, appliesTo: {} }], paragraphs)[0]
    if (!entry) {
      // 非必检规则没有命中线索时必须留痕，否则"没查"与"查过没问题"无法区分。
      result.notLocated.push({
        ruleId: rule.ruleId, reason: "no-match",
        detail: "未命中任何条款线索，未纳入本次检查。",
      })
      continue
    }
    planned.push(entry)
    const missingBasis = rule.basis.some(item => !sourceIds.has(item.sourceId))
    if (applies === "unknown" || missingBasis) {
      const reason = applies === "unknown" ? "规则所需的主体、项目或地域条件尚未确认。" : "本规则的必要来源未发布、停用或缺少正文。"
      result.findings.push({
        ruleId: rule.ruleId, category: rule.category, kind: "待核实", risk: reason,
        severity: rule.severity, severityOrigin: "规则预设", quote: "", paragraphIndex: -1,
        basis: [], impact: "", suggestion: "补齐并核对必要条件后重新审查。",
        pending: [reason], reviewStatus: "待人工复核",
      })
    } else {
      executable.push(entry)
      if (focus && !entry.excerpts.length) result.notLocated.push({
        ruleId: rule.ruleId, reason: "outline-only",
        detail: "未定位到正文，仅提供目录；该项检查范围不足，须待核实。",
      })
    }
  }
  if (!rules.length) result.errors.push({ ...safeError(new ReviewError("REVIEW_RULES_UNAVAILABLE")), ruleIds: [] })
  // 区分"条件不符"与"规则没命中内容"：两种原因给用户的下一步动作不同，不能静默返回空成功。
  else if (!executable.length) result.errors.push({
    ...safeError(new ReviewError(excluded ? "REVIEW_CONTEXT_UNMATCHED" : "REVIEW_RULES_UNMATCHED")), ruleIds: [],
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new ReviewError("REVIEW_TIMEOUT")), timeoutMs)
  const externalAbort = () => controller.abort(new ReviewError("REVIEW_CANCELLED"))
  options.signal?.addEventListener("abort", externalAbort, { once: true })
  if (options.signal?.aborted) externalAbort()
  const signal = controller.signal
  const outline = focus ? buildOutline(focus) : undefined
  const addError = (failure: unknown, batch: TriggeredRule[]) => result.errors.push({
    ...safeError(failure), ruleIds: batch.map(item => item.rule.ruleId),
  })
  try {
    for (let offset = 0; offset < executable.length; offset += batchSize) {
      const batch = executable.slice(offset, offset + batchSize)
      const basisIds = new Set(batch.flatMap(item => item.rule.basis.map(basis => basis.sourceId)))
      // 定向取材：命中段落所在块及前后各一块；仅有目录时保留待核实。
      const select = focus
        ? [...new Set(expandSegments(focus, batch.flatMap(item => item.excerpts.map(excerpt => excerpt.paragraphIndex)))
          .flatMap(segment => segment.indexes))]
        : undefined
      const prompt = buildPrompt({ paragraphs, triggered: batch, context, sources: sources.filter(source => basisIds.has(source.sourceId)), outline, select })
      if (prompt.system.length + prompt.user.length > maxPromptChars) {
        addError(new ReviewError("REVIEW_INPUT_TOO_LARGE"), batch); continue
      }
      try {
        let response: Awaited<ReturnType<AskModel>> | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted()
          if (result.callsUsed >= maxCalls) throw new ReviewError("REVIEW_BUDGET_EXHAUSTED")
          result.callsUsed++
          if (options.onBeforeCall) {
            try { await waitFor(options.onBeforeCall({ callNumber: result.callsUsed, ruleIds: batch.map(item => item.rule.ruleId) }), signal) }
            catch { signal.throwIfAborted(); throw new ReviewError("REVIEW_RESERVATION_FAILED") }
          }
          signal.throwIfAborted()
          try {
            response = await waitFor(options.model({ ...prompt, signal }), signal)
            break
          } catch (failure) {
            const code = safeError(failure).code
            const retryable = ["AI_NETWORK_ERROR", "AI_TIMEOUT", "AI_UPSTREAM_ERROR", "AI_RATE_LIMITED"].includes(code)
            if (!retryable || attempt > 0 || result.callsUsed >= maxCalls) throw failure
            // 限流按网关提供的 Retry-After 等待；等待计入总时限。
            const delay = failure instanceof ReviewError ? failure.retryAfterMs ?? 500 : 500
            await new Promise<void>((accept, reject) => {
              const abort = () => { clearTimeout(retryTimer); reject(signal.reason) }
              const retryTimer = setTimeout(() => { signal.removeEventListener("abort", abort); accept() }, delay)
              if (signal.aborted) { clearTimeout(retryTimer); reject(signal.reason) }
              else signal.addEventListener("abort", abort, { once: true })
            })
          }
        }
        if (!response) throw new ReviewError("REVIEW_MODEL_FAILED")
        if (response.usage) {
          result.usage = {
            inputTokens: (result.usage?.inputTokens ?? 0) + response.usage.inputTokens,
            outputTokens: (result.usage?.outputTokens ?? 0) + response.usage.outputTokens,
            totalTokens: (result.usage?.totalTokens ?? 0) + response.usage.totalTokens,
          }
        }
        const visible = select ? paragraphs.filter(item => select.includes(item.index)) : paragraphs
        const outcome = validateFindings(parseModelOutput(response.text), batch, visible, sourceIds,
          result.input.complete && visible.length === paragraphs.length)
        result.findings.push(...outcome.findings)
        result.rejected.push(...outcome.rejected)
      } catch (failure) {
        addError(signal.aborted ? signal.reason : failure, batch)
        if (signal.aborted || result.callsUsed >= maxCalls ||
            ["AI_NOT_CONFIGURED", "AI_CONFIG_INVALID", "AI_AUTH_ERROR", "AI_REQUEST_REJECTED", "REVIEW_RESERVATION_FAILED"].includes(safeError(failure).code)) break
      }
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", externalAbort)
  }
  for (const entry of planned) {
    if (!result.findings.some(item => item.ruleId === entry.rule.ruleId)) result.rejected.push({
      ruleId: entry.rule.ruleId, reason: "缺少结论", detail: "该必要检查未得到有效结论，可能漏答、被拒绝、失败或达到预算上限。",
    })
  }
  result.coverage = buildCoverage(result.findings, planned)
  const complete = result.input.complete && result.errors.length === 0 &&
    result.notLocated.length === 0 &&
    result.coverage.every(item => !["未覆盖", "待核实"].includes(item.status)) &&
    result.findings.length === planned.length && planned.length > 0
  result.status = complete ? "success" : result.findings.length ? "partial" : "failed"
  return result
}
