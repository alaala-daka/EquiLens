import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { ResultAuthorizer } from "../results/service"
import type { PaymentsService } from "./service"
import type { ProjectPaymentDraft } from "@/lib/payments/types"

export type PaymentsHttpServices = { identity(request: NextRequest): Promise<AuthIdentity>; authorize: ResultAuthorizer; service: PaymentsService }
const headers = { "Cache-Control": "private, no-store" }
export function paymentsHandler(services: () => Promise<PaymentsHttpServices>, revision = false) {
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
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new BusinessError("INVALID_INPUT", "请求内容无效。") }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BusinessError("INVALID_INPUT", "款项输入无效。")
      const body = parsed as Record<string, unknown>
      const allowed = revision ? ["operationId", "reason", "baseVersionId", "value"] : ["operationId", "reason", "value"]
      if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.operationId !== "string" || typeof body.reason !== "string" || (revision && (typeof body.baseVersionId !== "string" || !resultId))) throw new BusinessError("INVALID_INPUT", "款项输入无效。")
      const result = await service.save(identity, authorize, {
        projectId: id, ...(resultId ? { resultId, baseVersionId: body.baseVersionId as string } : {}),
        operationId: body.operationId, reason: body.reason, value: body.value as ProjectPaymentDraft,
      })
      return NextResponse.json(result, { headers })
    } catch (error) {
      if (isBusinessError(error)) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: httpStatus[error.code], headers })
      if (isAuthError(error)) return NextResponse.json({ error: { code: error.code, message: "身份验证失败。" } }, { status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "AUTH_UNAVAILABLE" || error.code === "AUTH_BUSY" ? 503 : 403, headers })
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "款项服务暂时不可用。" } }, { status: 503, headers })
    }
  }
}
