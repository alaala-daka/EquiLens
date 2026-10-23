import { NextResponse, type NextRequest } from "next/server"
import { identifier, sameOrigin, session } from "@/server/documents/http"
import { StoreError } from "@/server/documents/repository"
import { reviewAvailability, reviewTaskRepository, submitReview, submitReviewSchema } from "@/server/contract-review/tasks/service"
import { reviewBody, reviewFailure } from "@/server/contract-review/tasks/http"
import { wakeReviewRunner } from "@/server/contract-review/tasks/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const identity = session(request)
    const parameter = request.nextUrl.searchParams.get("documentId")
    const documentId = parameter ? identifier(parameter) : undefined
    const repository = await reviewTaskRepository()
    const [configuration, tasks] = await Promise.all([reviewAvailability(), repository.list(identity.owner, documentId)])
    return identity.apply(NextResponse.json({ configuration, tasks }))
  } catch (failure) { return reviewFailure(failure) }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request)
    const identity = session(request)
    const key = identifier(request.headers.get("Idempotency-Key"))
    const parsed = submitReviewSchema.safeParse(await reviewBody(request))
    if (!parsed.success) throw new StoreError(422, "请确认合同保存版本、审查条件和材料处理授权。")
    const task = await submitReview(identity.owner, key, parsed.data)
    wakeReviewRunner()
    return identity.apply(NextResponse.json(task, { status: 202 }))
  } catch (failure) { return reviewFailure(failure) }
}
