import { authConfig } from "./config"
import { AuthError, isAuthError } from "./errors"
import { assertAuthOrigin, readAuthCookie } from "./http"
import type { AuthIdentity, AuthService, SessionView } from "./service"

type Config = ReturnType<typeof authConfig>
type Dependencies = { services: () => Pick<AuthService, "login" | "session" | "logout">; config: () => Config; now: () => number }
type AccessDependencies = { services: () => Pick<AuthService, "session" | "revalidateSession">; config: () => Config }

/** Fresh checks only: returned identities are snapshots, never authorization caches. */
export function createAccountAccess(deps: AccessDependencies) {
  async function check(resolve: (services: ReturnType<AccessDependencies["services"]>, config: Config) => Promise<AuthIdentity | null>): Promise<AuthIdentity> {
    let identity: AuthIdentity | null
    try {
      const config = deps.config()
      identity = await resolve(deps.services(), config)
    } catch {
      throw new AuthError("AUTH_UNAVAILABLE", "认证服务暂不可用。")
    }
    if (!identity) throw new AuthError("UNAUTHENTICATED", "请先登录。")
    return identity
  }
  async function admin(identity: Promise<AuthIdentity>) {
    const current = await identity
    if (current.account.role !== "superadmin") throw new AuthError("FORBIDDEN", "无管理权限。")
    return current
  }
  return {
    requireSuperAdmin(request: Request): Promise<AuthIdentity> {
      return admin(check(async (services, config) => {
        const token = readAuthCookie(request, config.cookieName)
        return token ? services.session(token) : null
      }))
    },
    revalidateSuperAdminSession(sessionId: string): Promise<AuthIdentity> {
      return admin(check(async services => /^[a-f0-9]{64}$/.test(sessionId) ? services.revalidateSession(sessionId) : null))
    },
    requireAccount(request: Request): Promise<AuthIdentity> {
      return check(async (services, config) => {
        const token = readAuthCookie(request, config.cookieName)
        return token ? services.session(token) : null
      })
    },
    /** Internal session digest only; never expose this parameter as an HTTP credential. */
    revalidateAccountSession(sessionId: string): Promise<AuthIdentity> {
      return check(async services => /^[a-f0-9]{64}$/.test(sessionId) ? services.revalidateSession(sessionId) : null)
    },
  }
}
const messages = {
  FORBIDDEN: [403, "无管理权限。"],
  INVALID_INPUT: [400, "输入结构不合法。"], INVALID_CREDENTIALS: [401, "账号或密码错误。"],
  UNAUTHENTICATED: [401, "请先登录。"], INVALID_ORIGIN: [403, "请求来源无效。"],
  PAYLOAD_TOO_LARGE: [413, "请求正文过大。"], UNSUPPORTED_MEDIA_TYPE: [415, "请求正文须为 JSON。"],
  LOGIN_RATE_LIMITED: [429, "登录尝试过多，请稍后重试。"], AUTH_BUSY: [503, "认证繁忙，请稍后重试。"],
  AUTH_UNAVAILABLE: [503, "认证服务暂不可用。"],
} as const
function response(body: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra)
  headers.set("Cache-Control", "private, no-store")
  if (body !== null) headers.set("Content-Type", "application/json; charset=utf-8")
  return new Response(body === null ? null : JSON.stringify(body), { status, headers })
}
function failure(error: unknown) {
  const code = isAuthError(error) && Object.hasOwn(messages, error.code) ? error.code as keyof typeof messages : "AUTH_UNAVAILABLE"
  const [status, message] = messages[code]
  const headers = new Headers()
  if (code === "LOGIN_RATE_LIMITED" && isAuthError(error)) {
    const seconds = error.retryAfterSeconds
    headers.set("Retry-After", String(typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 1))
  }
  return response({ error: { code, message } }, status, headers)
}
function cookie(config: Config, token: string, seconds: number) {
  return `${config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? "; Secure" : ""}`
}
async function readBody(request: Request, limit: number) {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new AuthError(limit === 0 ? "INVALID_INPUT" : "PAYLOAD_TOO_LARGE", "") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
function view(user: SessionView["user"], expiresAt: number): SessionView { return { user: { id: user.id, username: user.username, role: user.role }, expiresAt: new Date(expiresAt).toISOString() } }
export function createAuthHandlers(deps: Dependencies) {
  return {
    async login(request: Request): Promise<Response> {
      try {
        const config = deps.config()
        assertAuthOrigin(request.headers.get("origin"), config.origin)
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) throw new AuthError("UNSUPPORTED_MEDIA_TYPE", "")
        const bytes = await readBody(request, 4096)
        let input: unknown
        try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new AuthError("INVALID_INPUT", "") }
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !("username" in input) || !("password" in input) || typeof input.username !== "string" || typeof input.password !== "string") throw new AuthError("INVALID_INPUT", "")
        const result = await deps.services().login(input.username, input.password, "deployment", readAuthCookie(request, config.cookieName) ?? undefined)
        return response(view(result.user, result.expiresAt), 200, { "Set-Cookie": cookie(config, result.token, Math.max(0, Math.floor((result.expiresAt - deps.now()) / 1000))) })
      } catch (error) { return failure(error) }
    },
    async session(request: Request): Promise<Response> {
      try {
        const config = deps.config(); const services = deps.services()
        if (new URL(request.url).search) throw new AuthError("INVALID_INPUT", "")
        const token = readAuthCookie(request, config.cookieName)
        const identity = token ? await services.session(token) : null
        if (!identity) {
          const result = failure(new AuthError("UNAUTHENTICATED", ""))
          result.headers.set("Set-Cookie", cookie(config, "", 0)); return result
        }
        return response(view(identity.account, identity.session.expiresAt))
      } catch (error) { return failure(error) }
    },
    async logout(request: Request): Promise<Response> {
      try {
        const config = deps.config()
        assertAuthOrigin(request.headers.get("origin"), config.origin)
        await readBody(request, 0)
        await deps.services().logout(readAuthCookie(request, config.cookieName) ?? "")
        return response(null, 204, { "Set-Cookie": cookie(config, "", 0) })
      } catch (error) { return failure(error) }
    },
  }
}
