import { verificationHandler } from "@/server/verification/http"
import { verificationHttpServices } from "@/server/verification/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = verificationHandler(verificationHttpServices, "get")
