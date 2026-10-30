import { modelConfig, ModelError } from "../ai/client"
import type { LoadedBidRequirementsInput } from "./input"
import { VerificationError } from "./types"

/**
 * C4-VERIFY requirement extractor (`bid-requirements` task, plan §4.7/§5).
 *
 * The model only proposes candidates; the executor maps every quote verbatim to
 * a project fragment and saves a `candidate` requirement set that a human must
 * confirm through the server-owned save path. No demo/fixed requirements are
 * ever produced: a model/config/parse failure fails the task without saving.
 *
 * The transport is injected (tests use a deterministic fake) and every request
 * is reserved through the unified runner before it leaves the process. At most
 * two requests are made (task catalogue `maxCalls: 2`), including one bounded
 * format-correction retry; neither the executor nor this module retries further.
 */
export type BidRequirementExtractorInput = {
  paragraphs: LoadedBidRequirementsInput["paragraphs"]
  complete: boolean
  asOf?: string
  maxCalls: number
  signal: AbortSignal
  env: Record<string, string | undefined>
  onBeforeCall(reservation: { callNumber: number }): Promise<void>
  onExchange(exchange: unknown): Promise<void>
}

/** Returns an unknown model payload; the executor normalizes it with parseRequirementCandidates. */
export type BidRequirementExtractor = (input: BidRequirementExtractorInput) => Promise<unknown>

const MAX_PROMPT_CHARS = 60_000
const REQUEST_TIMEOUT_MS = 90_000

export function bidRequirementPrompt(input: BidRequirementExtractorInput): string {
  const lines: string[] = []
  lines.push("你是投标资格审查助手。只从下面给出的招标/澄清/补遗材料原文中提出资格与材料要求候选，不得使用常识新增否决条件，不得编造原文。")
  lines.push("输出一个 JSON 对象：{\"candidates\":[{\"subject\":\"义务主体\",\"quote\":\"逐字原文引文\",\"nature\":\"资格否决|一般提交|可补正|评分|待确认\",\"field\":\"subject_name|unified_social_credit_code|certificate_kind|certificate_level|certificate_number|holder_name|holder_id_number|qualification_major|registered_unit|issue_date|expiry_date 之一或 null\",\"operator\":\"eq|neq|in|not_in|lte|gte|on_or_before|on_or_after|contains 之一或 null\",\"value\":\"比较值或值数组或 null\",\"asOfRule\":\"task_as_of|not_applicable\",\"materialRelation\":\"所需材料关系\",\"addendum\":{\"state\":\"none|conflict|revised\",\"note\":\"说明\"}}]}")
  lines.push("要求：quote 必须是下面某段原文的连续片段；无法确定性质/字段/运算时分别填 待确认/null/null，不要猜测；日期比较只能使用 lte/gte/on_or_before/on_or_after。只输出 JSON，不要解释。")
  if (input.asOf) lines.push(`本次判定日期：${input.asOf}`)
  lines.push("材料原文：")
  // Never silently truncate: a partial tender would make a partial extraction
  // look like a full qualification review (spec 01 §6.1/§7.2). The input cap
  // (120,000 chars) is larger than this prompt cap, so fail before any model call.
  const headerLength = lines.join("\n").length
  const total = input.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + 4, 0)
  if (!input.paragraphs.length || headerLength + total > MAX_PROMPT_CHARS) throw new VerificationError("EXTRACTOR_FAILED")
  for (const [index, paragraph] of input.paragraphs.entries()) lines.push(`[${index + 1}] ${paragraph.text}`)
  return lines.join("\n")
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.search(/[[{]/)
  if (start < 0) throw new VerificationError("EXTRACTOR_FAILED")
  const endObject = stripped.lastIndexOf("}")
  const endArray = stripped.lastIndexOf("]")
  const end = Math.max(endObject, endArray)
  if (end <= start) throw new VerificationError("EXTRACTOR_FAILED")
  try {
    return JSON.parse(stripped.slice(start, end + 1))
  } catch {
    throw new VerificationError("EXTRACTOR_FAILED")
  }
}

async function requestJson(options: {
  fetcher: typeof fetch
  config: ReturnType<typeof modelConfig>
  prompt: string
  callNumber: number
  signal: AbortSignal
  env: Record<string, string | undefined>
  onExchange: (exchange: unknown) => Promise<void>
}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort()
  options.signal.addEventListener("abort", abort, { once: true })
  let response: Response
  try {
    response = await options.fetcher(options.config.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.config.apiKey}` },
      body: JSON.stringify({
        model: options.config.model,
        messages: [{ role: "user", content: options.prompt }],
        stream: false,
        temperature: 0,
        max_tokens: 2000,
      }),
    })
  } catch {
    throw new VerificationError("EXTRACTOR_FAILED")
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener("abort", abort)
  }
  if (options.signal.aborted) throw new VerificationError("EXTRACTOR_FAILED")
  let payload: unknown
  try { payload = await response.json() } catch { throw new VerificationError("EXTRACTOR_FAILED") }
  const value = payload as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: unknown; tool_calls?: unknown[] } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const choice = value.choices?.[0]
  const usage = value.usage
  const exchange = {
    callNumber: options.callNumber,
    response: {
      model: (payload as { model?: unknown }).model ?? null,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      usage: usage && [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
        ? { promptTokens: Number(usage.prompt_tokens), completionTokens: Number(usage.completion_tokens), totalTokens: Number(usage.total_tokens) } : null,
    },
  }
  if (!response.ok) {
    await options.onExchange(exchange)
    throw new VerificationError("EXTRACTOR_FAILED")
  }
  await options.onExchange(exchange)
  const content = choice?.message?.content
  if (!content || typeof content !== "string" || choice?.message?.refusal || (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length)) {
    throw new VerificationError("EXTRACTOR_FAILED")
  }
  return extractJson(content)
}

/** Production extractor: single server-side chat request plus at most one format retry. */
export function createBidRequirementExtractor(options: { fetcher?: typeof fetch } = {}): BidRequirementExtractor {
  const fetcher = options.fetcher ?? fetch
  return async input => {
    let config: ReturnType<typeof modelConfig>
    try {
      config = modelConfig(input.env)
    } catch (failure) {
      if (failure instanceof ModelError) throw new VerificationError("SERVICE_UNAVAILABLE")
      throw new VerificationError("EXTRACTOR_FAILED")
    }
    const maxCalls = Math.min(Math.max(0, Math.floor(input.maxCalls) || 0), 2)
    if (maxCalls < 1) throw new VerificationError("BUDGET_EXHAUSTED")
    const prompt = bidRequirementPrompt(input)
    let lastFailure: unknown
    for (let callNumber = 1; callNumber <= maxCalls; callNumber++) {
      try {
        await input.onBeforeCall({ callNumber })
        const payload = await requestJson({ fetcher, config, prompt, callNumber, signal: input.signal, env: input.env, onExchange: input.onExchange })
        const candidates = Array.isArray(payload)
          ? payload
          : (payload && typeof payload === "object" && Array.isArray((payload as { candidates?: unknown }).candidates))
            ? (payload as { candidates: unknown[] }).candidates : null
        if (!candidates || candidates.length > 100) throw new VerificationError("EXTRACTOR_FAILED")
        return { candidates }
      } catch (failure) {
        lastFailure = failure
        if (callNumber >= maxCalls) break
      }
    }
    if (lastFailure instanceof VerificationError) throw lastFailure
    throw new VerificationError("EXTRACTOR_FAILED")
  }
}
