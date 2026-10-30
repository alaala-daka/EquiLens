import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { ResultAuthorizer } from "../results/service"
import type { VerificationService } from "./service"

/**
 * C4 verification HTTP handlers (spec 01 §8.2.3/§4.9, plan §4.9).
 *
 * Paths are wired by thin Node-runtime route files:
 * - GET  /api/projects/[id]/verifications
 * - GET  /api/projects/[id]/verifications/[resultId]
 * - POST /api/projects/[id]/verifications/requirements
 * - POST /api/projects/[id]/verifications/[resultId]/external-records
 *
 * Every response is private no-store; writes require the same Origin; the
 * project comes from the path, the browser cannot submit sources, dependencies,
 * a manifest or a result kind. Unknown/cross-project resources and non-C4 result
 * kinds share the uniform 404. Cost/price/model/executor keys are rejected.
 */
export type VerificationHttpServices = {
  identity: (request: NextRequest) => Promise<AuthIdentity>
  authorize: ResultAuthorizer
  service: VerificationService
}

export type VerificationOperation = "list" | "get" | "requirements" | "external-records"

type Context = { params: Promise<{ id: string; resultId?: string }> }
type Services = () => Promise<VerificationHttpServices>

const headers = { "Cache-Control": "private, no-store" }
const MAX_BODY = 262_144
const COMMON_FORBIDDEN = ["manifest", "model", "baseURL", "executor", "maxCalls", "maxCostFen", "price", "budget", "origin", "machineOutput", "sources", "dependencies", "projectId", "kind"]

async function body(request: NextRequest): Promise<Record<string, unknown>> {
  if (request.headers.get("origin") !== authConfig(process.env).origin) throw new BusinessError("FORBIDDEN", "请求来源无效。")
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT", "请求格式无效。")
  const reader = request.body?.getReader()
  if (!reader) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  let bytes = 0
  let text = ""
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY) {
        await reader.cancel()
        throw new BusinessError("LIMIT_EXCEEDED", "请求内容过大。")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    const input = parsed as Record<string, unknown>
    for (const key of COMMON_FORBIDDEN) if (key in input) throw new BusinessError("INVALID_INPUT", "核验请求内容无效。")
    return input
  } catch (failure) {
    if (isBusinessError(failure)) throw failure
    throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  }
}

function stringField(input: Record<string, unknown>, key: string, max: number, optional = false): string | undefined {
  const value = input[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BusinessError("INVALID_INPUT", "核验请求内容无效。")
  return value
}

export function verificationHandler(services: Services, operation: VerificationOperation) {
  return async (request: NextRequest, context: Context) => {
    try {
      const { id, resultId } = await context.params
      const { identity: resolve, authorize, service } = await services()
      const identity = await resolve(request)
      let result: unknown
      if (operation === "list") {
        result = { items: await service.list(identity, authorize, id) }
      } else if (operation === "get") {
        if (!resultId) throw new BusinessError("NOT_FOUND", "找不到该核验成果。")
        result = await service.get(identity, authorize, id, resultId)
      } else if (operation === "requirements") {
        const input = await body(request)
        const allowed = ["resultId", "baseVersionId", "operationId", "reason", "value"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT", "核验请求内容无效。")
        const operationId = stringField(input, "operationId", 128)!
        const reason = stringField(input, "reason", 500)!
        const baseVersionId = typeof input.baseVersionId === "string" ? input.baseVersionId : undefined
        if (baseVersionId === undefined || !("value" in input)) throw new BusinessError("INVALID_INPUT", "核验请求内容无效。")
        const optionalResultId = input.resultId === undefined ? undefined : stringField(input, "resultId", 128)
        result = await service.saveRequirementSet(identity, authorize, {
          projectId: id,
          ...(optionalResultId ? { resultId: optionalResultId } : {}),
          baseVersionId,
          operationId,
          reason,
          value: input.value,
        })
      } else {
        if (!resultId) throw new BusinessError("NOT_FOUND", "找不到该核验成果。")
        const input = await body(request)
        const allowed = ["versionId", "sha256", "requirementId", "subject", "certificateNo", "source", "queriedAt", "queryConditions", "conclusion", "proofMaterialVersionId"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT", "核验请求内容无效。")
        result = await service.recordExternalVerification(identity, authorize, {
          projectId: id,
          resultId,
          versionId: stringField(input, "versionId", 128)!,
          sha256: stringField(input, "sha256", 64)!,
          requirementId: stringField(input, "requirementId", 128)!,
          subject: stringField(input, "subject", 200)!,
          certificateNo: stringField(input, "certificateNo", 128)!,
          source: stringField(input, "source", 500)!,
          queriedAt: stringField(input, "queriedAt", 32)!,
          queryConditions: stringField(input, "queryConditions", 500)!,
          conclusion: stringField(input, "conclusion", 32)!,
          proofMaterialVersionId: stringField(input, "proofMaterialVersionId", 128)!,
        })
      }
      return NextResponse.json(result, { headers })
    } catch (error) {
      if (isBusinessError(error)) {
        return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: httpStatus[error.code], headers })
      }
      if (isAuthError(error)) {
        const status = error.code === "UNAUTHENTICATED" ? 401 : error.code === "AUTH_UNAVAILABLE" || error.code === "AUTH_BUSY" ? 503 : 403
        return NextResponse.json({ error: { code: error.code, message: "身份验证失败。" } }, { status, headers })
      }
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "核验服务暂时不可用。" } }, { status: 503, headers })
    }
  }
}
