import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import type { AuthIdentity } from "../auth/service"
import { isAuthError } from "../auth/errors"
import { httpStatus, isBusinessError } from "../projects/errors"
import type { TaskSubmission } from "./catalog"
import { isTaskError, TaskError } from "./errors"
import type { SubmitResult, TaskView } from "./repository"
import type { ProjectTaskAuthorizer } from "./service"

/**
 * Thin authenticated task HTTP adapter (A3a).
 *
 * Route files stay one-liners: compose the identity resolver from A1
 * createAccountAccess, pass C1's requireProjectAccess as `authorize`, and mount
 * these factories. No business logic, model configuration or manifest handling
 * lives here.
 *
 * A3a/C1 compatibility: the C1 project guard throws BusinessError (not
 * TaskError), so revoked membership, a non-member project and a missing project
 * keep their 401/403/404 mapping instead of falling back to 503.
 */
export type TaskHttpServices = {
  identity: (request: NextRequest) => Promise<AuthIdentity>
  authorize: ProjectTaskAuthorizer
  submit: (identity: AuthIdentity, authorize: ProjectTaskAuthorizer, submission: TaskSubmission) => Promise<SubmitResult>
  get: (identity: AuthIdentity, authorize: ProjectTaskAuthorizer, id: string) => Promise<TaskView>
  list: (identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string) => Promise<TaskView[]>
}
type Services = () => Promise<TaskHttpServices>
type Context = { params: Promise<{ id: string }> }

const maxBodyBytes = 256 * 1024
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function taskFailure(failure: unknown) {
  const headers = { "Cache-Control": "private, no-store" }
  if (isTaskError(failure)) {
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers })
  }
  // C0 business errors from the C1 project guard (UNAUTHENTICATED/FORBIDDEN/
  // NOT_FOUND/CONFLICT/LIMIT_EXCEEDED/...). Messages are fixed product strings.
  if (isBusinessError(failure)) {
    const status = httpStatus[failure.code] ?? 503
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status, headers })
  }
  if (isAuthError(failure)) {
    if (failure.code === "INVALID_ORIGIN") {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: "请求来源无效。" } }, { status: 403, headers })
    }
    const status = failure.code === "UNAUTHENTICATED" ? 401
      : failure.code === "FORBIDDEN" ? 403
        : failure.code === "AUTH_UNAVAILABLE" || failure.code === "AUTH_BUSY" ? 503
          : 400
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status, headers })
  }
  console.error("Task request failed")
  return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "任务服务暂时不可用。" } }, { status: 503, headers })
}

/**
 * Same-origin write check. The trusted origin comes only from APP_ORIGIN via
 * authConfig; a missing/invalid configuration is unavailable (503), never a
 * fallback to request.url or forwarded headers.
 */
function sameOrigin(request: NextRequest) {
  let expected: string
  try {
    expected = authConfig(process.env).origin
  } catch {
    throw new TaskError(503, "SERVICE_UNAVAILABLE", "任务服务暂时不可用。")
  }
  const origin = request.headers.get("origin")
  if (!origin || origin !== expected) throw new TaskError(403, "FORBIDDEN", "请求来源无效。")
}

/** Streamed JSON body with a hard 256 KiB limit; Content-Length is never trusted. */
async function jsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new TaskError(415, "INVALID_SUBMISSION", "请求格式无效。")
  }
  const reader = request.body?.getReader()
  if (!reader) throw new TaskError(400, "INVALID_SUBMISSION", "请求内容无效。")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodyBytes) {
        await reader.cancel()
        throw new TaskError(413, "INVALID_SUBMISSION", "请求内容过大。")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TaskError(400, "INVALID_SUBMISSION", "请求内容无效。")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskError(400, "INVALID_SUBMISSION", "请求内容无效。")
  }
  return value as Record<string, unknown>
}

/** Malformed identifiers are an input error; an unknown well-formed id is 404. */
function taskId(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) {
    throw new TaskError(422, "INVALID_SUBMISSION", "任务标识无效。")
  }
  return value
}

export function createTaskCollectionHandlers(getServices: Services) {
  return {
    async POST(request: NextRequest) {
      try {
        sameOrigin(request)
        const services = await getServices()
        const identity = await services.identity(request)
        const operationId = request.headers.get("idempotency-key")
        if (!operationId) throw new TaskError(422, "INVALID_SUBMISSION", "缺少任务提交标识。")
        const body = await jsonBody(request)
        if (Object.keys(body).some(key => !["kind", "projectId", "refs", "conditions"].includes(key))) {
          throw new TaskError(422, "INVALID_SUBMISSION", "请求内容无效。")
        }
        const result = await services.submit(identity, services.authorize, { ...body, operationId } as unknown as TaskSubmission)
        return NextResponse.json(result, { status: 202, headers: { "Cache-Control": "private, no-store" } })
      } catch (failure) { return taskFailure(failure) }
    },
    async GET(request: NextRequest) {
      try {
        const services = await getServices()
        const identity = await services.identity(request)
        const projectId = request.nextUrl.searchParams.get("projectId")
        if (!projectId) throw new TaskError(422, "INVALID_SUBMISSION", "缺少项目标识。")
        const tasks = await services.list(identity, services.authorize, projectId)
        return NextResponse.json({ tasks }, { headers: { "Cache-Control": "private, no-store" } })
      } catch (failure) { return taskFailure(failure) }
    },
  }
}

export function createTaskDetailHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest, context: Context) {
      try {
        const services = await getServices()
        const identity = await services.identity(request)
        const id = taskId((await context.params).id)
        const task = await services.get(identity, services.authorize, id)
        return NextResponse.json(task, { headers: { "Cache-Control": "private, no-store" } })
      } catch (failure) { return taskFailure(failure) }
    },
  }
}
