import { lettersHttpServices } from "@/server/letters/access"
import { lettersHandler } from "@/server/letters/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = lettersHandler(lettersHttpServices)
