import type { SessionView } from "@/server/auth/service"
import { AuthClientError } from "./client"
export function createSessionController(options: {
  check: () => Promise<SessionView>; leave: () => Promise<boolean>; logout: () => Promise<void>;
  clear: () => void; navigate: (path: string) => void;
}) {
  let exiting = false
  let checking: Promise<void> | undefined
  return {
    refresh(): Promise<void> {
      if (checking) return checking
      checking = (async () => {
        try { await options.check() }
        catch (error) {
          if (error instanceof AuthClientError && error.status === 401) { options.clear(); options.navigate("/login") }
          else throw error
        }
      })().finally(() => { checking = undefined })
      return checking
    },
    async exit() {
      if (exiting) return
      exiting = true
      try {
        if (!await options.leave()) return
        await options.logout()
        options.clear()
        options.navigate("/login")
      } finally { exiting = false }
    },
  }
}
export type SessionController = ReturnType<typeof createSessionController>
