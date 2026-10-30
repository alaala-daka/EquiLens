import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { ResultAuthorizer } from "../results/service"
import { saveCollectionLetterSchema, type LetterService } from "./service"

export type LettersHttpServices = { identity(request: NextRequest): Promise<AuthIdentity>; authorize: ResultAuthorizer; service: LetterService }
const headers = { "Cache-Control": "private, no-store" }

export function lettersHandler(services: () => Promise<LettersHttpServices>, revision = false) {
  return async (request: NextRequest, context: { params: Promise<{ id: string; resultId?: string }> }) => {
    try {
      const { id, resultId } = await context.params
      const { identity: resolve, authorize, service } = await services()
      const identity = await resolve(request)
      if (request.headers.get("origin") !== authConfig(process.env).origin) throw new BusinessError("FORBIDDEN", "请求来源无效。")
      if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT", "请求格式无效。")
      const reader = request.body?.getReader()
      if (!reader) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
      let size = 0, text = ""
      const decoder = new TextDecoder()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 262144) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED", "请求内容过大。") }
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock() }
      let body: unknown
      try { body = JSON.parse(text) } catch { throw new BusinessError("INVALID_INPUT", "催款函输入无效。") }
      const parsed = saveCollectionLetterSchema.safeParse(body)
      if (!parsed.success || (revision && !resultId)) throw new BusinessError("INVALID_INPUT", "催款函输入无效。")
      const result = await service.save(identity, authorize, id, { ...parsed.data, ...(resultId ? { resultId } : {}) })
      return NextResponse.json(result, { headers })
    } catch (error) {
      if (isBusinessError(error)) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: httpStatus[error.code], headers })
      if (isAuthError(error)) return NextResponse.json({ error: { code: error.code, message: "身份验证失败。" } }, { status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "AUTH_UNAVAILABLE" || error.code === "AUTH_BUSY" ? 503 : 403, headers })
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "催款函服务暂时不可用。" } }, { status: 503, headers })
    }
  }
}
