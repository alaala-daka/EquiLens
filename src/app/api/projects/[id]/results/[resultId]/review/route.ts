import { resultHandler } from "@/server/results/http"
import { resultHttpServices } from "@/server/results/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const POST = resultHandler(resultHttpServices, "review")
