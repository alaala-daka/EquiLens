import { draftingHandler } from "@/server/drafting/http"
import { draftingHttpServices } from "@/server/drafting/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = draftingHandler(draftingHttpServices, "list-inputs")
export const POST = draftingHandler(draftingHttpServices, "save-input")
