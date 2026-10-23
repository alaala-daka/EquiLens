import { modelConfig } from "../../../src/server/ai/client"
import { ReviewError, safeError } from "./errors"
import type { AskModel } from "./review"

export type GatewayOptions = {
  maxTokens?: number
  timeoutMs?: number
  fetcher?: typeof fetch
  env?: Record<string, string | undefined>
}

async function readBounded(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > 1024 * 1024) {
    await response.body?.cancel().catch(() => {})
    throw new ReviewError("AI_RESPONSE_INVALID")
  }
  if (!response.body) throw new ReviewError("AI_RESPONSE_INVALID")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) throw new ReviewError("AI_RESPONSE_INVALID")
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { return new TextDecoder("utf8", { fatal: true }).decode(bytes) }
    catch { throw new ReviewError("AI_RESPONSE_INVALID") }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewError("AI_RESPONSE_INVALID")
  return value as Record<string, unknown>
}

/** 一次调用只发送一次请求；分批、重试、总预算由 reviewContract 统一管理。 */
export function createGatewayAskModel(options: GatewayOptions = {}): AskModel {
  const maxTokens = options.maxTokens ?? 8192
  const timeoutMs = options.timeoutMs ?? 90000
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000) throw new ReviewError("REVIEW_INPUT_INVALID")
  const fetcher = options.fetcher ?? fetch
  return async ({ system, user, signal: parentSignal }) => {
    if (!system.trim() || !user.trim()) throw new ReviewError("REVIEW_INPUT_INVALID")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new ReviewError("AI_TIMEOUT")), timeoutMs)
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
    try {
      signal.throwIfAborted()
      const config = modelConfig(options.env ?? process.env)
      const response = await fetcher(config.endpoint, {
        method: "POST", redirect: "error", cache: "no-store", signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body: JSON.stringify({
          model: config.model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
          stream: false, max_tokens: maxTokens, response_format: { type: "json_object" },
        }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 401 || response.status === 403) throw new ReviewError("AI_AUTH_ERROR")
        if (response.status === 429) {
          const header = response.headers.get("retry-after")
          const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : NaN
          const date = header ? Date.parse(header) - Date.now() : NaN
          const wait = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date) : 1000
          throw new ReviewError("AI_RATE_LIMITED", Math.min(wait, 600000))
        }
        throw new ReviewError(response.status >= 500 ? "AI_UPSTREAM_ERROR" : "AI_REQUEST_REJECTED")
      }
      const raw = await readBounded(response)
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new ReviewError("AI_RESPONSE_INVALID") }
      const envelope = record(parsed)
      if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) throw new ReviewError("AI_RESPONSE_INVALID")
      const choice = record(envelope.choices[0])
      const message = record(choice.message)
      if (choice.finish_reason !== "stop" || message.refusal ||
          (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length)) ||
          message.function_call != null) throw new ReviewError("AI_OUTPUT_INCOMPLETE")
      if (typeof message.content !== "string" || !message.content.trim()) throw new ReviewError("AI_RESPONSE_INVALID")
      const usage = envelope.usage && typeof envelope.usage === "object" ? envelope.usage as Record<string, unknown> : {}
      const counts = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
      const valid = counts.every(count => Number.isSafeInteger(count) && (count as number) >= 0)
      return {
        text: message.content.trim(),
        usage: valid ? { inputTokens: counts[0] as number, outputTokens: counts[1] as number, totalTokens: counts[2] as number } : null,
      }
    } catch (failure) {
      if (signal.aborted) {
        if (controller.signal.aborted) throw new ReviewError("AI_TIMEOUT")
        throw new ReviewError("REVIEW_CANCELLED")
      }
      if (failure instanceof ReviewError) throw failure
      const error = safeError(failure)
      if (error.code !== "REVIEW_MODEL_FAILED") throw new ReviewError(error.code)
      throw new ReviewError("AI_NETWORK_ERROR")
    } finally { clearTimeout(timeout) }
  }
}
