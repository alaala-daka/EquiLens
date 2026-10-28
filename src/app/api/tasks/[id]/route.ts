import { createTaskDetailHandlers } from "@/server/tasks/http"
import { taskHttpServices } from "@/server/tasks/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const { GET } = createTaskDetailHandlers(taskHttpServices)
