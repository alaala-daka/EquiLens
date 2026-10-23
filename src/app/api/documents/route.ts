import { documentServices } from "@/server/documents/service"
import { createDocumentCollectionHandlers } from "@/server/documents/handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const { GET, POST } = createDocumentCollectionHandlers(documentServices)
