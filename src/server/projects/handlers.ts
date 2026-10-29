import type { AuthIdentity } from "../auth/service"
import { isAuthError } from "../auth/errors"
import { BusinessError, httpStatus, isBusinessError } from "./errors"
import type { ProjectService } from "./service"

export type ProjectHttpDependencies = {
  /** Production wiring is src/server/auth/access.ts requireAccount. */
  requireAccount: (request: Request) => Promise<AuthIdentity>
  service: ProjectService
  origin: () => string
}

type Services = () => Promise<ProjectHttpDependencies>
export type ProjectContext = { params: Promise<{ id: string }> }
export type ProjectMemberContext = { params: Promise<{ id: string; accountId: string }> }

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
})
const empty = () => new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } })

/** Fixed C0 error mapping: predefined safe messages only, never SQL or material text. */
function failure(value: unknown): Response {
  if (isBusinessError(value)) return json({ error: { code: value.code, message: value.message } }, httpStatus[value.code])
  if (isAuthError(value)) {
    if (value.code === "UNAUTHENTICATED") return json({ error: { code: "UNAUTHENTICATED", message: "请先登录。" } }, 401)
    if (value.code === "INVALID_ORIGIN") return json({ error: { code: "FORBIDDEN", message: "请求来源无效。" } }, 403)
    if (value.code === "FORBIDDEN") return json({ error: { code: "FORBIDDEN", message: "无权访问该项目。" } }, 403)
  }
  console.error("Project request failed")
  return json({ error: { code: "SERVICE_UNAVAILABLE", message: "服务暂不可用，请稍后重试。" } }, 503)
}

async function handle(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  } catch (failureValue) {
    return failure(failureValue)
  }
}

/** Same-origin writes only; forwarded/Host headers are never an origin authority. */
function assertOrigin(request: Request, configured: () => string): void {
  const expected = configured()
  const origin = request.headers.get("origin")
  if (!origin || origin !== expected) throw new BusinessError("FORBIDDEN", "请求来源无效。")
}

async function readJson(request: Request, limit = 16 * 1024): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  }
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  const reader = request.body?.getReader()
  if (!reader) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new BusinessError("INVALID_INPUT", "请求内容无效。")
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new BusinessError("INVALID_INPUT", "请求内容无效。")
  }
}

export function createProjectHandlers(getServices: Services) {
  return {
    collection: {
      async GET(request: Request): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          const identity = await deps.requireAccount(request)
          return json(await deps.service.list(identity))
        })
      },
      async POST(request: Request): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const body = await readJson(request)
          return json({ project: await deps.service.create(identity, body) }, 201)
        })
      },
    },
    detail: {
      async GET(request: Request, context: ProjectContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          const identity = await deps.requireAccount(request)
          const { id } = await context.params
          return json({ project: await deps.service.detail(identity, id) })
        })
      },
      async PATCH(request: Request, context: ProjectContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const { id } = await context.params
          const body = await readJson(request)
          return json({ project: await deps.service.update(identity, id, body) })
        })
      },
      async DELETE(request: Request, context: ProjectContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const { id } = await context.params
          await deps.service.remove(identity, id)
          return empty()
        })
      },
    },
    members: {
      async GET(request: Request, context: ProjectContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          const identity = await deps.requireAccount(request)
          const { id } = await context.params
          return json({ members: await deps.service.members(identity, id) })
        })
      },
      async POST(request: Request, context: ProjectContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const { id } = await context.params
          const body = await readJson(request)
          return json({ member: await deps.service.addMember(identity, id, body) }, 201)
        })
      },
    },
    member: {
      async PATCH(request: Request, context: ProjectMemberContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const { id, accountId } = await context.params
          const body = await readJson(request)
          return json({ member: await deps.service.changeRole(identity, id, accountId, body) })
        })
      },
      async DELETE(request: Request, context: ProjectMemberContext): Promise<Response> {
        return handle(async () => {
          const deps = await getServices()
          assertOrigin(request, deps.origin)
          const identity = await deps.requireAccount(request)
          const { id, accountId } = await context.params
          await deps.service.removeMember(identity, id, accountId)
          return empty()
        })
      },
    },
  }
}
