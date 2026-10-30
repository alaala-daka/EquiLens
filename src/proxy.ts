import { NextResponse, type NextRequest } from "next/server"

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * 开发环境把回环别名的 `Origin` 归一为 `APP_ORIGIN`。
 *
 * 同源校验按配置来源精确比较：配置 `http://localhost:3000` 时，用
 * `http://127.0.0.1:3000` 打开页面会发出 `Origin: 127.0.0.1`，所有写请求都会被
 * 以「请求来源无效」拒绝。这里只改写同一端口上的 localhost/127.0.0.1/[::1]，
 * 其他来源（含跨站）照旧被业务校验拒绝；生产环境完全不做改写。
 */
export default function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") return NextResponse.next()
  const configured = process.env.APP_ORIGIN
  const origin = request.headers.get("origin")
  if (!configured || !origin || origin === configured) return NextResponse.next()
  try {
    const actual = new URL(origin)
    const expected = new URL(configured)
    if (actual.protocol !== "http:" || expected.protocol !== "http:" || actual.port !== expected.port) return NextResponse.next()
    if (!LOOPBACK.has(actual.hostname) || !LOOPBACK.has(expected.hostname)) return NextResponse.next()
  } catch {
    return NextResponse.next()
  }
  const headers = new Headers(request.headers)
  headers.set("origin", configured)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }
