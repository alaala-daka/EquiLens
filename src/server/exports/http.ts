import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { exportHttpServices } from "./access"
import { docxContentType } from "./renderer"

type Context = { params: Promise<{ id: string; resultId: string; exportId?: string }> }
export function exportHandler(services: () => ReturnType<typeof exportHttpServices>, operation: "list" | "create" | "download") {
  return async (request: NextRequest, context: Context) => {
    const headers = { "Cache-Control": "private, no-store" }
    try {
      const { id,resultId,exportId } = await context.params
      const { identity: resolve,authorize,service } = await services()
      const identity = await resolve(request)
      if (operation === "download") {
        const bytes = await service.download(identity,authorize,id,resultId,exportId!)
        return new NextResponse(new Uint8Array(bytes),{ headers: { ...headers,"Content-Type": docxContentType,"Content-Disposition": 'attachment; filename="result.docx"',"X-Content-Type-Options": "nosniff" } })
      }
      if (operation === "list") return NextResponse.json(await service.list(identity,authorize,id,resultId),{ headers })
      if (request.headers.get("origin") !== authConfig(process.env).origin) throw new BusinessError("FORBIDDEN","请求来源无效。")
      if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT","请求格式无效。")
      const reader = request.body?.getReader()
      if (!reader) throw new BusinessError("INVALID_INPUT","请求内容无效。")
      let size = 0, text = ""
      const decoder = new TextDecoder()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 4096) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED","请求内容过大。") }
          text += decoder.decode(part.value,{ stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock() }
      let input: Record<string,unknown>
      try { input = JSON.parse(text) } catch { throw new BusinessError("INVALID_INPUT","导出输入无效。") }
      if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).some(key => !["versionId","sha256"].includes(key)) || typeof input.versionId !== "string" || typeof input.sha256 !== "string") throw new BusinessError("INVALID_INPUT","导出输入无效。")
      return NextResponse.json(await service.createExport(identity,authorize,{ projectId: id,resultId,versionId: input.versionId,sha256: input.sha256 }),{ status: 201,headers })
    } catch (error) {
      if (isBusinessError(error)) return NextResponse.json({ error: { code: error.code,message: error.message } },{ status: httpStatus[error.code],headers })
      if (isAuthError(error)) return NextResponse.json({ error: { code: error.code,message: "身份验证失败。" } },{ status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "AUTH_UNAVAILABLE" || error.code === "AUTH_BUSY" ? 503 : 403,headers })
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE",message: "导出服务暂时不可用。" } },{ status: 503,headers })
    }
  }
}
