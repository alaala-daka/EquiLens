import { exportHandler } from "@/server/exports/http"
import { exportHttpServices } from "@/server/exports/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = exportHandler(exportHttpServices,"download")
