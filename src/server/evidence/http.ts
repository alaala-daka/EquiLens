import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { ResultAuthorizer } from "../results/service"
import { saveEvidenceItemSchema, saveEvidenceReportSchema, type EvidenceProjectService } from "./project-service"
import { evidenceReportMarkdownFromView } from "./export-template"

export type EvidenceHttpServices = { identity(request: NextRequest): Promise<AuthIdentity>; authorize: ResultAuthorizer; service: EvidenceProjectService }
const headers = { "Cache-Control": "private, no-store" }

async function readBody(request: NextRequest): Promise<unknown> {
  if (request.headers.get("origin") !== authConfig(process.env).origin) throw new BusinessError("FORBIDDEN", "请求来源无效。")
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT", "请求格式无效。")
  const reader = request.body?.getReader()
  if (!reader) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 262144) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED", "请求内容过大。") }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new BusinessError("INVALID_INPUT", "请求内容无效。") }
}

export function evidenceHandler(services: () => Promise<EvidenceHttpServices>, operation: "items" | "history" | "saveItem" | "saveReport" | "reviseReport" | "markdown") {
  return async (request: NextRequest, context: { params: Promise<{ id: string; itemId?: string; resultId?: string }> }) => {
    try {
      const { id, itemId, resultId } = await context.params
      const { identity: resolve, authorize, service } = await services()
      const identity = await resolve(request)
      let value: unknown
      if (operation === "items") value = { items: await service.listItems(identity, authorize, id, request.nextUrl.searchParams.get("contractId") ?? undefined) }
      else if (operation === "history") {
        if (!itemId) throw new BusinessError("NOT_FOUND", "找不到该证据项。")
        value = { versions: await service.history(identity, authorize, id, itemId) }
      } else if (operation === "saveItem") {
        const parsed = saveEvidenceItemSchema.safeParse(await readBody(request))
        if (!parsed.success) throw new BusinessError("INVALID_INPUT", "证据项输入无效，请检查字段。")
        value = { item: await service.saveItem(identity, authorize, id, parsed.data) }
      } else if (operation === "markdown") {
        if (!resultId) throw new BusinessError("NOT_FOUND", "找不到该证据报告。")
        const view = await service.report(identity, authorize, id, resultId, request.nextUrl.searchParams.get("versionId") ?? undefined)
        return new NextResponse(evidenceReportMarkdownFromView(view), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="evidence-report.md"', "X-Content-Type-Options": "nosniff" } })
      } else {
        if (operation === "reviseReport" && !resultId) throw new BusinessError("NOT_FOUND", "找不到该证据报告。")
        const parsed = saveEvidenceReportSchema.safeParse(await readBody(request))
        if (!parsed.success) throw new BusinessError("INVALID_INPUT", "证据报告输入无效，请检查字段。")
        value = await service.saveReport(identity, authorize, id, { ...parsed.data, ...(resultId ? { resultId } : {}) })
      }
      return NextResponse.json(value, { headers })
    } catch (failure) {
      if (isBusinessError(failure)) return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: httpStatus[failure.code], headers })
      if (isAuthError(failure)) return NextResponse.json({ error: { code: failure.code, message: "身份验证失败。" } }, { status: failure.code === "UNAUTHENTICATED" ? 401 : failure.code === "AUTH_UNAVAILABLE" || failure.code === "AUTH_BUSY" ? 503 : 403, headers })
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "证据服务暂时不可用。" } }, { status: 503, headers })
    }
  }
}
