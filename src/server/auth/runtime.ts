import "server-only"
import { applicationDatabase } from "../database/runtime"
import { migrateBusiness } from "../database/migrations"
import { authConfig } from "./config"
import { cleanExpiredAuth } from "./cleanup"
import { createAuthRuntime } from "./runtime-core"
import { AuthService } from "./service"
const state = globalThis as typeof globalThis & {
  equilensAuthRuntime?: ReturnType<typeof createAuthRuntime>
}
const runtime = state.equilensAuthRuntime ??= createAuthRuntime({
  async initialize() {
    authConfig(process.env)
    const db = await applicationDatabase()
    await migrateBusiness(db)
    return new AuthService(db)
  },
  async sweep() { await cleanExpiredAuth(await applicationDatabase(), Date.now) },
  schedule(tick, interval) { const timer = setInterval(tick, interval); timer.unref(); return () => clearInterval(timer) },
})
export const startAuthRuntime = () => runtime.start()
export const stopAuthRuntime = () => runtime.stop()
export const authServices = () => runtime.get()
