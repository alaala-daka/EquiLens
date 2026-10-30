import { paymentsHandler } from "@/server/payments/http"
import { paymentsHttpServices } from "@/server/payments/access"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const POST = paymentsHandler(paymentsHttpServices, true)
