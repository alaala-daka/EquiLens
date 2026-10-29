import { NextResponse, type NextRequest } from "next/server"
import { authConfig } from "../auth/config"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { taskFailure } from "./http"
import type { ProjectBudgetView } from "./budget"
import type { ProjectTaskAuthorizer } from "./service"

export type ProjectBudgetServices = {
  identity(request: NextRequest): Promise<AuthIdentity>
  authorize: ProjectTaskAuthorizer
}

export type ProjectBudgetDependencies = {
  read(identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string): Promise<ProjectBudgetView | null>
  register(identity: AuthIdentity, authorize: ProjectTaskAuthorizer, projectId: string, costLimitFen: number): Promise<ProjectBudgetView>
}

type Context = { params: Promise<{ id: string }> }

const headers = { "Cache-Control": "private, no-store" }

/**
 * Admin project budget registration/read. Paid project tasks are refused until a
 * budget row exists; the browser never supplies prices or per-call estimates.
 */
export function createProjectBudgetHandlers(
  getServices: () => Promise<ProjectBudgetServices>,
  dependencies: ProjectBudgetDependencies,
) {
  return {
    async GET(request: NextRequest, context: Context) {
      try {
        const { id } = await context.params
        const services = await getServices()
        const identity = await services.identity(request)
        const budget = await dependencies.read(identity, services.authorize, id)
        return NextResponse.json({ budget }, { headers })
      } catch (failure) { return taskFailure(failure) }
    },
    async POST(request: NextRequest, context: Context) {
      try {
        const expected = authConfig(process.env).origin
        if (request.headers.get("origin") !== expected) throw new BusinessError("FORBIDDEN", "请求来源无效。")
        if (!request.headers.get("content-type")?.startsWith("application/json")) throw new BusinessError("INVALID_INPUT", "请求格式无效。")
        const reader = request.body?.getReader()
        if (!reader) throw new BusinessError("INVALID_INPUT", "请求内容无效。")
        let size = 0, text = ""
        const decoder = new TextDecoder()
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > 4096) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED", "请求内容过大。") }
            text += decoder.decode(part.value, { stream: true })
          }
          text += decoder.decode()
        } finally { reader.releaseLock() }
        let input: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(text)
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
          input = parsed as Record<string, unknown>
        } catch { throw new BusinessError("INVALID_INPUT", "预算输入无效。") }
        if (Object.keys(input).some(key => key !== "costLimitFen") || typeof input.costLimitFen !== "number" || !Number.isSafeInteger(input.costLimitFen) || input.costLimitFen <= 0) throw new BusinessError("INVALID_INPUT", "预算输入无效。")
        const { id } = await context.params
        const services = await getServices()
        const identity = await services.identity(request)
        const budget = await dependencies.register(identity, services.authorize, id, input.costLimitFen as number)
        return NextResponse.json({ budget }, { headers })
      } catch (failure) { return taskFailure(failure) }
    },
  }
}
