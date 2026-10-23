import { NextResponse, type NextRequest } from "next/server"
import type { DocumentServices } from "./service"
import { StoreError } from "./errors"
import { creation, failureResponse, identifier, inputBody, jsonBody, sameOrigin, session, wire } from "./http"

type Services = () => Promise<DocumentServices>
type Context = { params: Promise<{ id: string }> }

async function resource(request: NextRequest, services: DocumentServices, action: "read" | "save" | "create" | "copy") {
  const identity = session(request)
  const contextId = request.headers.get("X-Document-Context") ?? ""
  await services.sessions.assertContext(identity.owner, contextId)
  await services.sessions.assertAccess(identity.owner, action)
  return { identity, contextId }
}

// Serialize before the final access check: reading a Blob may outlive its session deadline.
async function respond(request: NextRequest, services: DocumentServices, value: unknown, status = 200) {
  const response = NextResponse.json(value, { status })
  const { identity, contextId } = await resource(request, services, "read")
  response.headers.set("X-Document-Context", contextId)
  return identity.apply(response)
}

export function createDocumentCollectionHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest) {
      try {
        const services = await getServices()
        const { identity } = await resource(request, services, "read")
        return await respond(request, services, await services.documents.list(identity.owner))
      } catch (failure) { return failureResponse(failure) }
    },
    async POST(request: NextRequest) {
      try {
        sameOrigin(request)
        const services = await getServices()
        // Check identity before parsing private content; repository repeats the action guard after validation.
        const { identity } = await resource(request, services, "read")
        const input = creation(await inputBody(request))
        await resource(request, services, input.source === "copy" ? "copy" : "create")
        const saved = await services.documents.create(identity.owner, input)
        return await respond(request, services, await wire(saved), 201)
      } catch (failure) { return failureResponse(failure) }
    },
  }
}

export function createDocumentVersionHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest, context: Context) {
      try {
        const services = await getServices()
        const { identity } = await resource(request, services, "read")
        const opened = await services.documents.open(identity.owner, identifier((await context.params).id))
        return await respond(request, services, await wire(opened))
      } catch (failure) { return failureResponse(failure) }
    },
    async PUT(request: NextRequest, context: Context) {
      try {
        sameOrigin(request)
        const services = await getServices()
        const { identity } = await resource(request, services, "save")
        const body = await inputBody(request)
        await resource(request, services, "save")
        const saved = await services.documents.save(identity.owner, { documentId: identifier((await context.params).id), baseRevision: identifier(body.baseRevision), operationId: identifier(body.operationId), title: body.title, prompt: body.prompt, blob: body.blob })
        return await respond(request, services, await wire(saved))
      } catch (failure) { return failureResponse(failure) }
    },
  }
}

export function createDocumentSessionHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest) {
      try {
        const identity = session(request)
        const view = await (await getServices()).sessions.view(identity.owner)
        return identity.apply(NextResponse.json(view))
      } catch (failure) { return failureResponse(failure) }
    },
    async POST(request: NextRequest) {
      try {
        sameOrigin(request)
        const services = await getServices()
        const identity = session(request)
        const body = await jsonBody(request, 1024)
        if (body.action !== "restart" || typeof body.expectedContextId !== "string" || Object.keys(body).some(key => key !== "action" && key !== "expectedContextId")) throw new StoreError(400, "会话操作无效。")
        await services.sessions.assertContext(identity.owner, body.expectedContextId)
        const previous = await services.sessions.view(identity.owner)
        if (previous.state !== "expired") throw new StoreError(409, "当前会话不能重新开始。", "SESSION_RESTART_NOT_ALLOWED", previous)
        if (!previous.canRestart) throw new StoreError(503, "资料保留期限配置不可用。", "RETENTION_UNCONFIGURED", previous)
        const replacement = session(request, { rotate: true })
        const view = await services.sessions.view(replacement.owner)
        if (!view.canCreate) throw new StoreError(503, "资料保留期限配置不可用。", "RETENTION_UNCONFIGURED", previous)
        return replacement.apply(NextResponse.json(view))
      } catch (failure) { return failureResponse(failure) }
    },
  }
}
