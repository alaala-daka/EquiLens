import type { SessionView } from "@/server/auth/service"
export function createLoginController(options: { submit: (username: string, password: string) => Promise<SessionView>; onSuccess: (session: SessionView) => void }) {
  let running = false
  return {
    pending: () => running,
    async run(username: string, password: string) {
      if (running) return
      running = true
      try { options.onSuccess(await options.submit(username, password)) }
      finally { running = false }
    },
  }
}
