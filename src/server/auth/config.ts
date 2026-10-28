import { AuthError } from "./errors"
export function authConfig(env: Record<string, string | undefined>) {
  const unavailable = () => new AuthError("AUTH_UNAVAILABLE", "认证服务暂不可用。")
  const raw = env.APP_ORIGIN
  if (!raw) throw unavailable()
  let url: URL
  try { url = new URL(raw) } catch { throw unavailable() }
  if (url.origin !== raw || url.username || url.password) throw unavailable()
  const secure = url.protocol === "https:"
  if (!secure && !(env.NODE_ENV === "development" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw unavailable()
  return { origin: raw, secure, cookieName: secure ? "__Host-equilens-auth" : "equilens-auth-dev", source: "deployment" }
}
