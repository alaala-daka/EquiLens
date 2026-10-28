import { createHash } from "node:crypto"
import type { ReviewResult } from "../../../tools/contract-review/src/types"

export type ExchangeRetention = "summary" | "full"
export type ModelExchange = { callNumber: number; request: unknown; response: unknown; agentRole?: string; elapsedMs?: number }
export type ExchangeSummary = {
  version: 1; callNumber: number; agentRole: string | null; requestSha256: string; responseSha256: string
  model: string | null; reportedModel: string | null; elapsedMs: number | null; finishReason: string | null
  toolNames: string[]; usage: ReviewResult["usage"]; knownTotalTokens: number | null
}
export function exchangeRetention(env: Record<string, string | undefined>): ExchangeRetention {
  const mode = env.AI_EXCHANGE_RETENTION ?? "summary"
  if (mode !== "summary" && mode !== "full") throw new Error("AI_EXCHANGE_RETENTION 配置无效。")
  return mode
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex")
const safeName = (value: unknown) => typeof value === "string" && /^[\w./:-]{1,100}$/.test(value) ? value : null
export function responseUsage(response: unknown): ReviewResult["usage"] {
  const usage = (response as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } | null)?.usage
  if (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null
  return { inputTokens: usage.prompt_tokens!, outputTokens: usage.completion_tokens!, totalTokens: usage.total_tokens! }
}
export function summarizeExchange(value: ModelExchange): ExchangeSummary {
  const request = value.request as { model?: unknown }, response = value.response as { model?: unknown; choices?: { finish_reason?: unknown; message?: { tool_calls?: { function?: { name?: unknown } }[] } }[] } | null
  const finish = response?.choices?.[0]?.finish_reason, tools = response?.choices?.[0]?.message?.tool_calls
  return { version: 1, callNumber: value.callNumber, agentRole: safeName(value.agentRole), requestSha256: digest(value.request), responseSha256: digest(value.response),
    model: safeName(request?.model), reportedModel: safeName(response?.model), elapsedMs: Number.isSafeInteger(value.elapsedMs) && value.elapsedMs! >= 0 ? value.elapsedMs! : null,
    finishReason: typeof finish === "string" && /^[a-z_-]{1,40}$/.test(finish) ? finish : null,
    toolNames: Array.isArray(tools) ? [...new Set(tools.map(item => safeName(item?.function?.name)).filter((name): name is string => name !== null))] : [], usage: responseUsage(value.response), knownTotalTokens: totalTokens(value.response) }
}
function totalTokens(response: unknown): number | null {
  const count = (response as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null
}
type ExchangeRow = { stage?: unknown; ordinal?: unknown; payload?: unknown }
/** 每个任务调用序号唯一；双写/旧记录恢复时摘要优先，不能重复累计。 */
export function recordedUsage(rows: ExchangeRow[]): ReviewResult["usage"] {
  const byCall = new Map<number, { summary: boolean; usage: ReviewResult["usage"] }>()
  for (const row of rows) {
    const value = JSON.parse(String(row.payload)), summary = row.stage === "model-summary", id = Number(row.ordinal)
    if (!Number.isSafeInteger(id) || id < 1 || (!summary && byCall.get(id)?.summary)) continue
    byCall.set(id, { summary, usage: summary ? responseUsage({ usage: { prompt_tokens: value.usage?.inputTokens, completion_tokens: value.usage?.outputTokens, total_tokens: value.usage?.totalTokens } }) : responseUsage(value.response) })
  }
  const known = [...byCall.values()].map(item => item.usage).filter((value): value is NonNullable<ReviewResult["usage"]> => value !== null)
  return known.length ? known.reduce((sum, value) => ({ inputTokens: sum.inputTokens + value.inputTokens, outputTokens: sum.outputTokens + value.outputTokens, totalTokens: sum.totalTokens + value.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null
}
export function recordedTokenCount(rows: ExchangeRow[]): number {
  const byCall = new Map<number, { summary: boolean; total: number | null }>()
  for (const row of rows) {
    const value = JSON.parse(String(row.payload)), summary = row.stage === "model-summary", id = Number(row.ordinal)
    if (!Number.isSafeInteger(id) || id < 1 || (!summary && byCall.get(id)?.summary)) continue
    const count = summary ? value.knownTotalTokens ?? value.usage?.totalTokens : totalTokens(value.response)
    byCall.set(id, { summary, total: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null })
  }
  return [...byCall.values()].reduce((sum, item) => sum + (item.total ?? 0), 0)
}
