import { evidenceHttpServices } from "@/server/evidence/access"
import { evidenceHandler } from "@/server/evidence/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = evidenceHandler(evidenceHttpServices, "reviseReport")
