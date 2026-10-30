import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { resultHttpServices } from "./access"
import type { ReviewInput, SaveResultInput } from "./service"
import type { ResultRevisionRef } from "../../lib/business/contracts"
type Context = { params: Promise<{ id: string; resultId?: string }> }
type Services = () => ReturnType<typeof resultHttpServices>
const headers = { "Cache-Control": "private, no-store" }
async function body(request: NextRequest) {
  if (request.headers.get("origin") !== authConfig(process.env).origin) throw new BusinessError("FORBIDDEN","请求来源无效。")
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT","请求格式无效。")
  const reader = request.body?.getReader()
  if (!reader) throw new BusinessError("INVALID_INPUT","请求内容无效。")
  let bytes = 0, text = ""
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 262144) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED","请求内容过大。") }
      text += decoder.decode(chunk.value,{ stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string,unknown>
  } catch { throw new BusinessError("INVALID_INPUT","请求内容无效。") }
}
export function resultHandler(services: Services, operation: "list" | "get" | "save" | "validate" | "review") {
  return async (request: NextRequest, context: Context) => {
    try {
      const { id, resultId } = await context.params
      const { identity: resolve, authorize, service } = await services()
      const identity = await resolve(request)
      let result: unknown
      if (operation === "list") result = await service.list(identity,authorize,id)
      else if (operation === "get") result = await service.get(identity,authorize,id,resultId!,request.nextUrl.searchParams.get("versionId") ?? undefined)
      else {
        const input = await body(request)
        if (input.projectId !== undefined && input.projectId !== id || input.resultId !== undefined && resultId && input.resultId !== resultId || "origin" in input || "machineOutput" in input) throw new BusinessError("INVALID_INPUT","成果输入无效。")
        const allowed = operation === "save" ? ["projectId","resultId","kind","baseVersionId","operationId","reason","value","sources","dependencies"] : operation === "review" ? ["projectId","resultId","versionId","sha256","decision","comment"] : ["projectId","resultId","versionId","sha256"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT","成果输入无效。")
        if (operation === "save") {
          if (!["kind","baseVersionId","operationId","reason"].every(key => typeof input[key] === "string") || !("value" in input) || !Array.isArray(input.sources) || !Array.isArray(input.dependencies)) throw new BusinessError("INVALID_INPUT","成果输入无效。")
        } else if (typeof input.versionId !== "string" || typeof input.sha256 !== "string") throw new BusinessError("INVALID_INPUT","成果输入无效。")
        const scoped = { ...input,projectId: id,...(resultId ? { resultId } : {}) }
        if (operation === "save") result = await service.saveResultRevision(identity,authorize,scoped as SaveResultInput)
        else if (operation === "validate") result = await service.validateResult(identity,authorize,scoped as ResultRevisionRef)
        else result = await service.reviewResult(identity,authorize,scoped as ReviewInput)
      }
      return NextResponse.json(result,{ headers })
    } catch (error) {
      if (isBusinessError(error)) return NextResponse.json({ error: { code: error.code,message: error.message } },{ status: httpStatus[error.code],headers })
      if (isAuthError(error)) return NextResponse.json({ error: { code: error.code,message: "身份验证失败。" } },{ status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "AUTH_UNAVAILABLE" || error.code === "AUTH_BUSY" ? 503 : 403,headers })
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE",message: "成果服务暂时不可用。" } },{ status: 503,headers })
    }
  }
}
