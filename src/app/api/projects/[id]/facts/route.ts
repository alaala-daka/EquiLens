import { factsHttpServices } from "@/server/facts/access"
import { factsHandler } from "@/server/facts/http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = factsHandler(factsHttpServices, "list")
export const POST = factsHandler(factsHttpServices, "save")
