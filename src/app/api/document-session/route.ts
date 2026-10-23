import { documentServices } from "@/server/documents/service"
import { createDocumentSessionHandlers } from "@/server/documents/handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const { GET, POST } = createDocumentSessionHandlers(documentServices)
