import "server-only"
import { projectEditorServices } from "@/server/materials/editor-runtime"
import { createProjectEditorHandlers } from "@/server/materials/editor-http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const handlers = createProjectEditorHandlers(projectEditorServices)
export const GET = handlers.list
export const POST = handlers.create
