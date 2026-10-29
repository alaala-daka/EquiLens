import { AuthError } from "./errors"
import type { AuthService } from "./service"
type Dependencies = { initialize(): Promise<AuthService>; sweep(): Promise<void>; schedule(tick: () => void, interval: number): () => void }
export function createAuthRuntime({ initialize, sweep, schedule }: Dependencies) {
  let state: "idle" | "starting" | "ready" | "failed" | "stopped" = "idle"
  let service: AuthService | undefined
  let startup: Promise<void> | undefined
  let sweeping: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let cancel: (() => void) | undefined
  const tick = () => {
    if (state !== "ready" || sweeping) return
    sweeping = Promise.resolve().then(sweep).catch(() => { console.error("Authentication cleanup failed") }).finally(() => { sweeping = undefined })
  }
  return {
    start() {
      if (stopping || state === "starting" || state === "ready") return
      state = "starting"
      startup = Promise.resolve().then(initialize).then(value => {
        if (state !== "starting") return
        const cancelSchedule = schedule(tick, 3600000)
        if (state !== "starting") { cancelSchedule(); return }
        cancel = cancelSchedule
        service = value
        state = "ready"
        tick()
      }).catch(() => {
        if (state === "starting") state = "failed"
        service = undefined
        console.error("Authentication initialization failed")
      }).finally(() => { startup = undefined })
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      state = "stopped"; service = undefined
      cancel?.(); cancel = undefined
      stopping = (async () => { await startup; await sweeping })().finally(() => { stopping = undefined })
      return stopping
    },
    get(): AuthService {
      if (state !== "ready" || !service) throw new AuthError("AUTH_UNAVAILABLE", "认证服务暂不可用。")
      return service
    },
  }
}

