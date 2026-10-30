import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import { isAuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError, httpStatus, isBusinessError } from "../projects/errors"
import type { ResultAuthorizer } from "../results/service"
import type { DraftingService } from "./service"

/**
 * C5 drafting HTTP handlers (spec 01 §8.2.4, plan §5 C5).
 *
 * Paths are wired by thin Node-runtime route files:
 * - GET/POST /api/projects/[id]/drafting-inputs
 * - GET      /api/projects/[id]/drafting-inputs/[inputId]
 * - POST     /api/projects/[id]/drafts
 * - POST     /api/projects/[id]/drafts/[resultId]/revisions
 *
 * Every response is private no-store; writes require the same Origin; the
 * project comes from the path. The browser cannot submit sources, dependencies,
 * rendered paragraphs, a result kind/value, a manifest, model address or
 * template content — those keys are rejected before the service runs.
 */
export type DraftingHttpServices = {
  identity: (request: NextRequest) => Promise<AuthIdentity>
  authorize: ResultAuthorizer
  service: DraftingService
}

export type DraftingOperation = "list-inputs" | "get-input" | "save-input" | "generate" | "revise"
type Context = { params: Promise<{ id: string; inputId?: string; resultId?: string }> }
type Services = () => Promise<DraftingHttpServices>

const headers = { "Cache-Control": "private, no-store" }
const MAX_BODY = 262_144
const COMMON_FORBIDDEN = [
  "projectId", "kind", "value", "sources", "dependencies", "manifest", "model", "baseURL", "executor",
  "maxCalls", "maxCostFen", "price", "budget", "origin", "machineOutput", "paragraphs", "missing", "warnings", "template",
]

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
    for (const key of COMMON_FORBIDDEN) if (key in input) throw new BusinessError("INVALID_INPUT", "文书起草请求内容无效。")
    return input
  } catch (failure) {
    if (isBusinessError(failure)) throw failure
    throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  }
}

function stringField(input: Record<string, unknown>, key: string, max: number, optional = false): string | undefined {
  const value = input[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BusinessError("INVALID_INPUT", "文书起草请求内容无效。")
  return value
}

export function draftingHandler(services: Services, operation: DraftingOperation) {
  return async (request: NextRequest, context: Context) => {
    try {
      const { id, inputId, resultId } = await context.params
      const { identity: resolve, authorize, service } = await services()
      const identity = await resolve(request)
      let result: unknown
      if (operation === "list-inputs") {
        result = await service.listInputs(identity, authorize, id)
      } else if (operation === "get-input") {
        if (!inputId) throw new BusinessError("NOT_FOUND", "找不到该拟约定输入。")
        result = await service.getInput(identity, authorize, id, inputId)
      } else if (operation === "save-input") {
        const input = await body(request)
        const allowed = ["inputId", "templateId", "baseVersionId", "operationId", "fields", "originalContract"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT", "文书起草请求内容无效。")
        const optionalInputId = input.inputId === undefined ? undefined : stringField(input, "inputId", 128)
        result = await service.saveInput(identity, authorize, {
          projectId: id,
          templateId: stringField(input, "templateId", 128)!,
          ...(optionalInputId ? { inputId: optionalInputId } : {}),
          baseVersionId: typeof input.baseVersionId === "string" ? input.baseVersionId : "",
          operationId: stringField(input, "operationId", 128)!,
          fields: input.fields,
          ...(input.originalContract === undefined ? {} : { originalContract: input.originalContract }),
        })
      } else if (operation === "generate") {
        const input = await body(request)
        const allowed = ["inputId", "versionId", "sha256", "operationId", "reason"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT", "文书起草请求内容无效。")
        result = await service.generateDraft(identity, authorize, {
          projectId: id,
          inputId: stringField(input, "inputId", 128)!,
          versionId: stringField(input, "versionId", 128)!,
          sha256: stringField(input, "sha256", 64)!,
          operationId: stringField(input, "operationId", 128)!,
          reason: stringField(input, "reason", 500)!,
        })
      } else {
        if (!resultId) throw new BusinessError("NOT_FOUND", "找不到该草稿成果。")
        const input = await body(request)
        const allowed = ["baseVersionId", "inputId", "versionId", "sha256", "operationId", "reason"]
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new BusinessError("INVALID_INPUT", "文书起草请求内容无效。")
        result = await service.reviseDraft(identity, authorize, {
          projectId: id,
          resultId,
          baseVersionId: stringField(input, "baseVersionId", 128)!,
          inputId: stringField(input, "inputId", 128)!,
          versionId: stringField(input, "versionId", 128)!,
          sha256: stringField(input, "sha256", 64)!,
          operationId: stringField(input, "operationId", 128)!,
          reason: stringField(input, "reason", 500)!,
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
      return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "文书起草服务暂时不可用。" } }, { status: 503, headers })
    }
  }
}
