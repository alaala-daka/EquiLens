import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { identifier, sameOrigin, session } from "../../documents/http"
import { StoreError } from "../../documents/errors"
import type { DocumentSessionRepository } from "../../documents/session-repository"
import type { ReviewAvailability, ReviewTask, SubmitReview } from "../../../lib/contract-reviews/types"
import type { ReviewTaskRepository } from "./repository"
import { submitReviewSchema } from "./schema"
import { reviewBody, reviewFailure } from "./http"

export type ReviewHttpServices = {
  sessions: DocumentSessionRepository
  repository: ReviewTaskRepository
  configuration: () => Promise<ReviewAvailability>
  submit: (owner: string, key: string, request: SubmitReview, contextId: string) => Promise<ReviewTask>
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
