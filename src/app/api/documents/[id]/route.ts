import { documentServices } from "@/server/documents/service"
import { createDocumentVersionHandlers } from "@/server/documents/handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const { GET, PUT } = createDocumentVersionHandlers(documentServices)
