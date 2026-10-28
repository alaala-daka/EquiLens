import { createDocumentRevisionsHandlers } from "@/server/contract-review/tasks/handlers"
import { reviewHttpServices } from "@/server/contract-review/tasks/http-services"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const handlers = createDocumentRevisionsHandlers(reviewHttpServices)
export const GET = handlers.GET
export const POST = handlers.POST
