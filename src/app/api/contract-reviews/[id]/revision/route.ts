import { createReviewRevisionHandler, createRevisionSubmissionHandler } from "@/server/contract-review/tasks/handlers"
import { reviewHttpServices } from "@/server/contract-review/tasks/http-services"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = createReviewRevisionHandler(reviewHttpServices)
export const POST = createRevisionSubmissionHandler(reviewHttpServices)
