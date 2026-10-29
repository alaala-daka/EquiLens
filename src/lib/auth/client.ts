import type { SessionView } from "@/server/auth/service"
export class AuthClientError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter?: number) { super(message) }
}
export function createAuthClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response
    try { response = await fetcher(path, { ...init, cache: "no-store", credentials: "same-origin" }) }
    catch { throw new AuthClientError(0, "网络连接失败，请重试。") }
    if (!response.ok) {
      const retry = Number(response.headers.get("Retry-After"))
      const seconds = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined
      const message = response.status === 429 ? (seconds ? `请求过于频繁，请在 ${seconds} 秒后重试。` : "请求过于频繁，请稍后重试。")
        : response.status === 401 ? (path.endsWith("login") ? "账号或密码错误。" : "会话已失效，请重新登录。")
        : "请求失败，请稍后重试。"
      throw new AuthClientError(response.status, message, seconds)
    }
    return response
  }
  return {
    async login(username: string, password: string): Promise<SessionView> { return (await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) })).json() },
    async session(): Promise<SessionView> { return (await request("/api/auth/session")).json() },
    async logout(): Promise<void> { await request("/api/auth/logout", { method: "POST" }) },
  }
}
export const authClient = createAuthClient()
