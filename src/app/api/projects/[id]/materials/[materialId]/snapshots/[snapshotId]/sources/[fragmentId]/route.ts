import "server-only"
import { materialHttpServices } from "@/server/materials/http-runtime"
import { createMaterialHandlers } from "@/server/materials/http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const handlers = createMaterialHandlers(materialHttpServices)
export const GET = handlers.source
