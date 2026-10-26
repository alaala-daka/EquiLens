import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { modelConfig } from "../../../../src/server/ai/client"
import { incompleteOutput, ReviewError } from "../errors"

export type AgentModelOptions = {
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  signal: AbortSignal
  maxPromptChars: number
  requestTimeoutMs: number
  beforeRequest: () => Promise<void>
  afterResponse: () => void
  onFailure: (failure: ReviewError) => void
  onExchange?: (exchange: { request: unknown; response: unknown }) => Promise<void>
  lengthRepairInstruction?: string
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > 1024 * 1024) {
    await response.body?.cancel().catch(() => {})
    throw new ReviewError("AI_RESPONSE_INVALID")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ReviewError("AI_RESPONSE_INVALID")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) { await reader.cancel(); throw new ReviewError("AI_RESPONSE_INVALID") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return new Uint8Array(Buffer.concat(chunks))
}

/** SDK 自动重试由调用方关闭；每次真正发出的 HTTP 请求都经过同一预算入口。 */
export function createAgentModel(options: AgentModelOptions) {
  const config = modelConfig(options.env ?? process.env)
  let lengthRepairUsed = false
  const provider = createOpenAICompatible({
    name: "contract-gateway", baseURL: config.endpoint.replace(/\/chat\/completions$/, ""), apiKey: config.apiKey,
    fetch: async (url, init) => {
      let requestSignal: AbortSignal | undefined
      try {
        options.signal.throwIfAborted()
        if (typeof init?.body !== "string" || init.body.length > options.maxPromptChars) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
        let body = init.body
        for (;;) {
          options.signal.throwIfAborted()
          if (body.length > options.maxPromptChars) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
          await options.beforeRequest()
          options.signal.throwIfAborted()
          requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs), ...(init.signal ? [init.signal] : [])])
          const response = await (options.fetcher ?? fetch)(url, { ...init, body, signal: requestSignal, redirect: "error", cache: "no-store" })
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            if ([401, 403].includes(response.status)) throw new ReviewError("AI_AUTH_ERROR")
            if (response.status === 429) throw new ReviewError("AI_RATE_LIMITED")
            throw new ReviewError(response.status >= 500 ? "AI_UPSTREAM_ERROR" : "AI_REQUEST_REJECTED")
          }
          const bytes = await responseBytes(response, requestSignal)
          let value
          try { value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) }
          catch { throw new ReviewError("AI_RESPONSE_INVALID") }
          options.signal.throwIfAborted()
          // 失败响应也属于本次不可变调用证据，须在结束原因校验之前保存；不记录 header 或密钥。
          try { await options.onExchange?.({ request: JSON.parse(body), response: value }) }
          catch { options.signal.throwIfAborted(); throw new ReviewError("REVIEW_PROGRESS_FAILED") }
          const choice = value?.choices?.[0]
          if (!Array.isArray(value?.choices) || value.choices.length !== 1 || !choice?.message) throw new ReviewError("AI_RESPONSE_INVALID")
          if (!choice.message.refusal && choice.finish_reason === "length" && !lengthRepairUsed) {
            lengthRepairUsed = true
            const request = JSON.parse(body)
            body = JSON.stringify({ ...request, messages: [...request.messages, {
              role: "user", content: options.lengthRepairInstruction ?? "上次输出达到长度上限，回答未被采用。不要重写全部分析；本回合只调用一个当前可用的工具。仍须先读取必要材料；若已具备条件而调用submitFindings，只提交1条规则结论。保持简短，引用必要的完整原文片段；其余工作留待后续回合。",
            }] })
            continue
          }
          if (choice.message.refusal || !["stop", "tool_calls"].includes(choice.finish_reason)) throw incompleteOutput(choice.finish_reason, choice.message.refusal)
          if (choice.finish_reason === "tool_calls" && (!Array.isArray(choice.message.tool_calls) || !choice.message.tool_calls.length || choice.message.tool_calls.length > 32)) throw new ReviewError("AI_RESPONSE_INVALID")
          options.signal.throwIfAborted()
          options.afterResponse()
          const headers = new Headers(response.headers)
          // 已经读取的是解压后的正文；避免让 SDK 再按上游压缩/长度信息解释。
          headers.delete("content-encoding")
          headers.delete("content-length")
          return new Response(new Uint8Array(bytes).buffer, { status: response.status, headers })
        }
      } catch (failure) {
        const safe = failure instanceof ReviewError ? failure : options.signal.aborted
          ? options.signal.reason instanceof ReviewError ? options.signal.reason : new ReviewError("REVIEW_CANCELLED")
          : requestSignal?.aborted ? new ReviewError("AI_TIMEOUT") : new ReviewError("AI_NETWORK_ERROR")
        options.onFailure(safe)
        throw safe
      }
    },
  })
  return { model: provider.chatModel(config.model), modelName: config.model }
}
