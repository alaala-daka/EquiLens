import "server-only"
import { createProjectBudgetHandlers } from "@/server/tasks/budget-http"
import { taskHttpServices } from "@/server/tasks/access"
import { projectBudget, registerProjectBudget } from "@/server/tasks/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const handlers = createProjectBudgetHandlers(taskHttpServices, { read: projectBudget, register: registerProjectBudget })
export const GET = handlers.GET
export const POST = handlers.POST
