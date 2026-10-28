import { AuthError } from "./errors"

/** Call before login/logout or other writes. Forwarded headers are not trusted here. */
export function assertAuthOrigin(origin: string | null, configured: string | undefined) {
  try {
    if (!origin || !configured) throw new Error()
    const expected = new URL(configured)
    if (!["https:", "http:"].includes(expected.protocol) || expected.username || expected.password || expected.search || expected.hash || expected.pathname !== "/") throw new Error()
    if (origin !== expected.origin) throw new Error()
  } catch { throw new AuthError("INVALID_ORIGIN", "请求来源无效。") }
}

/** Ambiguous cookie headers are never resolved by ordering. */
export function readAuthCookie(request: Request, cookieName: string): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === cookieName)
  if (matches.length !== 1) return null
  const value = matches[0].slice(cookieName.length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? value : null
}
