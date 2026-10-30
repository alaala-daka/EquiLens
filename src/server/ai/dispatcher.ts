import "server-only"
import { Agent, fetch as undiciFetch } from "undici"

/**
 * 长耗时模型请求专用的 fetch。
 *
 * Node 内置 fetch（undici）默认的 headers/body 超时是 300 秒，而推理模型的单次请求
 * 常需 3—8 分钟：超时会被当成网络错误（`AI_NETWORK_ERROR`），与真正的超时/限流混在一起。
 * 这里用一个独立的 Agent 把两类超时放宽到 10 分钟；请求级超时仍由调用方通过
 * `AbortSignal`（`AI_REQUEST_TIMEOUT_MS`）控制，任务总预算由任务运行器控制。
 */
const headersTimeoutMs = 600_000
const bodyTimeoutMs = 600_000
let agent: Agent | undefined

export function longRunningModelFetch(): typeof fetch {
  agent ??= new Agent({ headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs, connectTimeout: 30_000 })
  const current = agent
  // undici 的 Response 与 DOM lib 的 Response 结构一致，只是迭代器类型声明不同；
  // 该 fetch 只在 Node 服务端供 AI SDK 使用，转换仅用于对齐类型。
  const dispatcherFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher: current } as never)
  return dispatcherFetch as unknown as typeof fetch
}
