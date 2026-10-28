import "server-only"
import { createAuthMethodPolicy } from "@/server/auth/methods"
import { createAuthHandlers } from "@/server/auth/handlers"
import { authConfig } from "@/server/auth/config"
import { authServices } from "@/server/auth/runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const handlers = createAuthHandlers({ services: authServices, config: () => authConfig(process.env), now: Date.now })
const policy = createAuthMethodPolicy("GET", handlers.session)
export const GET = policy.GET
export const HEAD = policy.HEAD
export const POST = policy.POST
export const PUT = policy.PUT
export const PATCH = policy.PATCH
export const DELETE = policy.DELETE
export const OPTIONS = policy.OPTIONS
