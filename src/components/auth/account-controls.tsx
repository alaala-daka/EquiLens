"use client"

import { useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { AuthClientError } from "@/lib/auth/client"
import type { SessionController } from "@/lib/auth/session-controller"

/** Mount only inside an authorized project host with its unified leave callback. */
export function AccountControls({ controller, username }: { controller: SessionController; username: string }) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => { void controller.refresh().then(() => { if (active) setError("") }).catch(() => { if (active) setError("会话检查失败，请重试。") }) }
    refresh()
    window.addEventListener("focus", refresh)
    return () => { active = false; window.removeEventListener("focus", refresh) }
  }, [controller, pathname, search])
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm">{username}</span>
      <Button variant="outline" disabled={pending} aria-busy={pending} onClick={async () => {
        setPending(true); setError("")
        try { await controller.exit() }
        catch (failure) { setError(failure instanceof AuthClientError ? failure.message : "退出失败，请重试。") }
        finally { setPending(false) }
      }}>退出登录</Button>
      <FieldError aria-live="polite">{error}</FieldError>
    </div>
  )
}
