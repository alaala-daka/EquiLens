import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { identifier, sameOrigin, session } from "@/server/documents/http"
import { StoreError } from "@/server/documents/repository"
import { reviewTaskRepository } from "@/server/contract-review/tasks/service"
import { reviewBody, reviewFailure } from "@/server/contract-review/tasks/http"
import { cancelRunningReview, wakeReviewRunner } from "@/server/contract-review/tasks/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("retry"), externalProcessingConsent: z.literal(true) }).strict(),
])
export async function GET(request: NextRequest, context: Context) {
  try {
    const identity = session(request)
    const task = await (await reviewTaskRepository()).get(identity.owner, identifier((await context.params).id))
    return identity.apply(NextResponse.json(task))
  } catch (failure) { return reviewFailure(failure) }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    sameOrigin(request)
    const identity = session(request)
    const id = identifier((await context.params).id)
    const input = actionSchema.safeParse(await reviewBody(request))
    if (!input.success) throw new StoreError(422, "审查操作或处理授权无效。")
    const task = await (await reviewTaskRepository()).action(identity.owner, id, input.data.action)
    if (input.data.action === "cancel") cancelRunningReview(id)
    else wakeReviewRunner()
    return identity.apply(NextResponse.json(task))
  } catch (failure) { return reviewFailure(failure) }
}
