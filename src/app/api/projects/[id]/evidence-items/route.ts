import { evidenceHttpServices } from "@/server/evidence/access"
import { evidenceHandler } from "@/server/evidence/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const handlers = evidenceHandler(evidenceHttpServices, "items")
export const GET = handlers
export const POST = evidenceHandler(evidenceHttpServices, "saveItem")
