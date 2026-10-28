import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { identifier, sameOrigin, session } from "../../documents/http"
import { StoreError } from "../../documents/errors"
import type { DocumentSessionRepository } from "../../documents/session-repository"
import type { ReviewAvailability, ReviewTask, SubmitReview } from "../../../lib/contract-reviews/types"
import type { ReviewTaskRepository } from "./repository"
import { submitReviewSchema, revisionTaskSchema, documentRevisionSchema, documentReviewSchema } from "./schema"
import { reviewBody, reviewFailure } from "./http"
import { RevisionDownloadError } from "./errors"

export type ReviewHttpServices = {
  sessions: DocumentSessionRepository
  repository: ReviewTaskRepository
  configuration: () => Promise<ReviewAvailability>
  submit: (owner: string, key: string, request: SubmitReview, contextId: string) => Promise<ReviewTask>
  submitRevision: (owner: string, key: string, sourceTaskId: string, ruleIds: string[], contextId: string) => Promise<ReviewTask>
  wake: () => void
  cancel: (id: string) => void
}
type Services = () => Promise<ReviewHttpServices>
type Context = { params: Promise<{ id: string }> }
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("retry"), externalProcessingConsent: z.literal(true) }).strict(),
])

async function access(request: NextRequest, services: ReviewHttpServices, action: "read" | "review") {
  const identity = session(request)
  const contextId = request.headers.get("X-Document-Context") ?? ""
  await services.sessions.assertContext(identity.owner, contextId)
  await services.sessions.assertAccess(identity.owner, action)
  return { identity, contextId }
}
async function respond(request: NextRequest, services: ReviewHttpServices, value: unknown, status = 200) {
  const response = NextResponse.json(value, { status })
  const { identity, contextId } = await access(request, services, "read")
  response.headers.set("X-Document-Context", contextId)
  return identity.apply(response)
}

export function createReviewCollectionHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest) {
      try {
        const services = await getServices()
        const { identity, contextId } = await access(request, services, "read")
        const parameter = request.nextUrl.searchParams.get("documentId")
        const documentId = parameter ? identifier(parameter) : undefined
        const [configuration, tasks] = await Promise.all([services.configuration(), services.repository.list(identity.owner, documentId, contextId)])
        return await respond(request, services, { configuration, tasks })
      } catch (failure) { return reviewFailure(failure) }
    },
    async POST(request: NextRequest) {
      try {
        sameOrigin(request)
        const services = await getServices()
        const { identity, contextId } = await access(request, services, "review")
        const key = identifier(request.headers.get("Idempotency-Key"))
        const parsed = submitReviewSchema.safeParse(await reviewBody(request))
        if (!parsed.success) throw new StoreError(422, "请确认合同保存版本、审查条件和材料处理授权。")
        const task = await services.submit(identity.owner, key, parsed.data, contextId)
        services.wake()
        return await respond(request, services, task, 202)
      } catch (failure) { return reviewFailure(failure) }
    },
  }
}

export function createReviewDetailHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest, context: Context) {
      try {
        const services = await getServices()
        const { identity, contextId } = await access(request, services, "read")
        const task = await services.repository.get(identity.owner, identifier((await context.params).id), contextId)
        return await respond(request, services, task)
      } catch (failure) { return reviewFailure(failure) }
    },
    async POST(request: NextRequest, context: Context) {
      try {
        sameOrigin(request)
        const services = await getServices()
        await access(request, services, "read")
        const id = identifier((await context.params).id)
        const input = actionSchema.safeParse(await reviewBody(request))
        if (!input.success) throw new StoreError(422, "审查操作或处理授权无效。")
        const { identity, contextId } = await access(request, services, input.data.action === "retry" ? "review" : "read")
        const task = await services.repository.action(identity.owner, id, input.data.action, contextId)
        if (input.data.action === "cancel") services.cancel(id)
        else services.wake()
        return await respond(request, services, task)
      } catch (failure) { return reviewFailure(failure) }
    },
  }
}

export function createRevisionSubmissionHandler(getServices: Services) {
  return async function POST(request: NextRequest, context: Context) {
    try {
      sameOrigin(request)
      const services = await getServices()
      const { identity, contextId } = await access(request, services, "review")
      const key = identifier(request.headers.get("Idempotency-Key"))
      const parsed = revisionTaskSchema.safeParse(await reviewBody(request))
      if (!parsed.success) throw new StoreError(422, "请选择需要修订的问题并确认外发。")
      const id = identifier((await context.params).id)
      const task = await services.submitRevision(identity.owner, key, id, parsed.data.ruleIds, contextId)
      services.wake()
      return await respond(request, services, task, 202)
    } catch (failure) { return reviewFailure(failure) }
  }
}

export function createReviewRevisionHandler(getServices: Services) {
  return async function GET(request: NextRequest, context: Context) {
    try {
      const services = await getServices()
      const { identity, contextId } = await access(request, services, "read")
      const file = await services.repository.revisionExport(identity.owner, identifier((await context.params).id), contextId)
      await access(request, services, "read")
      const response = new NextResponse(new Uint8Array(file.bytes), { headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
        "Cache-Control": "private, no-store", "X-Document-Context": contextId, "X-Content-SHA256": file.sha256,
      } })
      return identity.apply(response)
    } catch (failure) {
      // A task pointer is private data too; recheck before returning it, as for DOCX bytes.
      if (failure instanceof RevisionDownloadError && failure.revisionTaskId) {
        try {
          const services = await getServices(), { identity, contextId } = await access(request, services, "read")
          await services.repository.get(identity.owner, identifier((await context.params).id), contextId)
          await services.repository.get(identity.owner, failure.revisionTaskId, contextId)
        } catch (denied) { return reviewFailure(denied) }
      }
      return reviewFailure(failure)
    }
  }
}

export function createDocumentRevisionsHandlers(getServices: Services) {
  return {
    async GET(request: NextRequest, context: Context) {
      try {
        const services = await getServices(), { identity, contextId } = await access(request, services, "read")
        const value = await services.repository.documentRevisions(identity.owner, identifier((await context.params).id), contextId)
        return await respond(request, services, value)
      } catch (failure) { return reviewFailure(failure) }
    },
    async POST(request: NextRequest, context: Context) {
      try {
        sameOrigin(request)
        const services = await getServices(), { identity, contextId } = await access(request, services, "review")
        const parsed = documentRevisionSchema.safeParse(await reviewBody(request, 512 * 1024))
        if (!parsed.success) throw new StoreError(422, "修订内容无效或缺少修改理由。")
        const value = await services.repository.saveDocumentRevision(identity.owner, identifier((await context.params).id), contextId, parsed.data)
        return await respond(request, services, value, 201)
      } catch (failure) { return reviewFailure(failure) }
    },
  }
}

export function createDocumentReviewHandler(getServices: Services) {
  return async function POST(request: NextRequest, context: Context & { params: Promise<{ id: string; revisionId: string }> }) {
    try {
      sameOrigin(request)
      const services = await getServices(), { identity, contextId } = await access(request, services, "review")
      const params = await context.params
      const versionId = params.revisionId
      if (!/^(?:machine|[0-9a-f-]{36})$/.test(versionId)) throw new StoreError(404, "找不到该结果版本。")
      const parsed = documentReviewSchema.safeParse(await reviewBody(request))
      if (!parsed.success) throw new StoreError(422, "复核结论或意见无效。")
      const value = await services.repository.reviewDocumentRevision(identity.owner, identifier(params.id), contextId, versionId, parsed.data)
      return await respond(request, services, value, 201)
    } catch (failure) { return reviewFailure(failure) }
  }
}

export function createReviewedLetterDownloadHandler(getServices: Services) {
  return async function GET(request: NextRequest, context: Context & { params: Promise<{ id: string; revisionId: string }> }) {
    try {
      const services = await getServices(), { identity, contextId } = await access(request, services, "read")
      const params = await context.params
      const file = await services.repository.reviewedLetterExport(identity.owner, identifier(params.id), contextId, params.revisionId)
      await access(request, services, "read")
      return identity.apply(new NextResponse(new Uint8Array(file.bytes), { headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
        "Cache-Control": "private, no-store", "X-Document-Context": contextId, "X-Content-SHA256": file.sha256,
      } }))
    } catch (failure) { return reviewFailure(failure) }
  }
}

export function createLetterDownloadHandler(getServices: Services) {
  return async function GET(request: NextRequest, context: Context) {
    try {
      const services = await getServices(), { identity, contextId } = await access(request, services, "read")
      const file = await services.repository.letterExport(identity.owner, identifier((await context.params).id), contextId)
      await access(request, services, "read")
      return identity.apply(new NextResponse(new Uint8Array(file.bytes), { headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
        "Cache-Control": "private, no-store", "X-Document-Context": contextId, "X-Content-SHA256": file.sha256,
      } }))
    } catch (failure) { return reviewFailure(failure) }
  }
}
