import "server-only"
import { projectHttpServices } from "@/server/projects/access"
import { createProjectHandlers } from "@/server/projects/handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const handlers = createProjectHandlers(projectHttpServices)
export const GET = handlers.deletion.GET
