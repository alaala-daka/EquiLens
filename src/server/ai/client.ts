export class ModelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "ModelError"
  }
}

export type ModelConfig = { endpoint: string; apiKey: string; model: string }
export type ModelReply = { text: string; model: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null }

// Pure configuration/transport functions: only the server entrypoint reads process.env.
export function modelConfig(env: Record<string, string | undefined>): ModelConfig {
  const apiKey = env.AI_API_KEY?.trim()
  if (!apiKey) throw new ModelError("AI_NOT_CONFIGURED", "未配置 AI_API_KEY，请在本机环境文件或服务端环境中设置。")
  const model = env.AI_MODEL?.trim() ?? "glm-5.3-flash"
  let base: URL
  try {
    base = new URL(env.AI_BASE_URL?.trim() ?? "https://aigw.saurlax.com/v1")
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error()
    base.pathname = base.pathname.replace(/\/+$/, "") + "/"
    if (!/^[\w./:-]{1,100}$/.test(model) || /[\r\n]/.test(apiKey)) throw new Error()
  } catch { throw new ModelError("AI_CONFIG_INVALID", "模型服务配置无效，请检查 HTTPS 地址和模型名称。") }
  return { endpoint: new URL("chat/completions", base).href, apiKey, model }
}

function networkError(failure: unknown): ModelError {
  const timedOut = failure instanceof Error && (failure.name === "TimeoutError" || failure.name === "AbortError")
  return timedOut
    ? new ModelError("AI_TIMEOUT", "模型请求超时，请稍后重试。")
    : new ModelError("AI_NETWORK_ERROR", "无法连接模型服务，请检查网络后重试。")
}

export async function askModel(prompt: string, config: ModelConfig, fetcher: typeof fetch = fetch): Promise<ModelReply> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20000) throw new ModelError("AI_INPUT_INVALID", "测试消息须为非空文字，且不超过 20,000 字符。")
  let response: Response
  try {
    response = await fetcher(config.endpoint, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 256 }),
    })
  } catch (failure) { throw networkError(failure) }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) throw new ModelError("AI_AUTH_ERROR", "模型服务鉴权失败，请检查密钥和模型访问权限。")
    if (response.status === 429) throw new ModelError("AI_RATE_LIMITED", "模型服务请求受限，请稍后重试。")
    throw new ModelError("AI_UPSTREAM_ERROR", response.status === 402 ? "模型服务余额不足，请检查账户。" : "模型服务暂时不可用，请稍后重试。")
  }

  const reader = response.body?.getReader()
  if (!reader) throw new ModelError("AI_RESPONSE_INVALID", "模型服务返回了空响应。")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) {
        await reader.cancel().catch(() => {})
        throw new ModelError("AI_RESPONSE_INVALID", "模型响应超过大小限制。")
      }
      chunks.push(value)
    }
  } catch (failure) {
    if (failure instanceof ModelError) throw failure
    throw networkError(failure)
  } finally { reader.releaseLock() }

  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw new ModelError("AI_RESPONSE_INVALID", "模型响应不是有效的 JSON。") }
  const choice = value?.choices?.[0]
  if (!Array.isArray(value?.choices) || value.choices.length !== 1 || !choice?.message) throw new ModelError("AI_RESPONSE_INVALID", "模型响应缺少有效回答。")
  const text = choice.message.content
  if (choice.finish_reason !== "stop") throw new ModelError("AI_OUTPUT_INCOMPLETE", "模型未正常完成回答，可能被截断或拒绝。")
  if (typeof text !== "string" || !text.trim() || text.length > 64000 || choice.message.refusal || (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length))) throw new ModelError("AI_RESPONSE_INVALID", "模型未返回可用的纯文本回答。")
  const usage = value.usage
  const validUsage = usage && [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(count => Number.isSafeInteger(count) && count >= 0)
  return {
    text: text.trim(),
    model: typeof value.model === "string" && /^[\w./:-]{1,100}$/.test(value.model) ? value.model : config.model,
    usage: validUsage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : null,
  }
}
