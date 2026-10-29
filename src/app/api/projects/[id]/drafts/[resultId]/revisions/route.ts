import { draftingHandler } from "@/server/drafting/http"
import { draftingHttpServices } from "@/server/drafting/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const POST = draftingHandler(draftingHttpServices, "revise")
