/**
 * 单次模型请求的超时（毫秒）。
 *
 * 推理模型（如 spark-x2.6）会先消耗大量 reasoning token，单次请求经常超过 90 秒；
 * 统一由 `AI_REQUEST_TIMEOUT_MS` 配置，默认 240 秒，允许 1—600 秒。
 * 该值只限制单次请求；任务整体超时与调用预算另由任务运行器负责。
 */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 240_000
export const MAX_AI_REQUEST_TIMEOUT_MS = 600_000

export function requestTimeoutFromEnv(env: Record<string, string | undefined>): number {
  const raw = Number(env.AI_REQUEST_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AI_REQUEST_TIMEOUT_MS
  return Math.min(Math.max(Math.round(raw), 1_000), MAX_AI_REQUEST_TIMEOUT_MS)
}
