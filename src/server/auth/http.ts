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
