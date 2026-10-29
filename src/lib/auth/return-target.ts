/** Accept only local absolute paths, including after repeated percent decoding. */
export function safeReturnTarget(value: string | null, origin: string): string {
  if (!value) return "/"
  try {
    let decoded = value
    for (let depth = 0; depth <= value.length; depth++) {
      if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\u0000-\u0020\u007f-\u009f]/.test(decoded)) return "/"
      const parsed = new URL(decoded, origin)
      if (parsed.origin !== new URL(origin).origin) return "/"
      const next = decodeURIComponent(decoded)
      if (next === decoded) return value
      decoded = next
    }
  } catch { return "/" }
  return "/"
}
