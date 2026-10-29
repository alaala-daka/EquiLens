"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LogInIcon, LogOutIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { accountEntryState, type AccountEntryState } from "@/lib/auth/account-entry"
import { AuthClientError, authClient } from "@/lib/auth/client"

/**
 * Optional account entry for the anonymous document workbench.
 * Signing in or out never reads, migrates or clears the anonymous document session.
 */
export function AccountEntry() {
  const router = useRouter()
  const [state, setState] = useState<AccountEntryState>({ kind: "loading" })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [retryCount, setRetryCount] = useState(0)
  const attempt = useRef(0)

  useEffect(() => {
    let active = true
    const probe = () => {
      const generation = ++attempt.current
      authClient.session().then(
        session => { if (active && generation === attempt.current) setState(accountEntryState({ ok: true, session })) },
        failure => { if (active && generation === attempt.current) setState(accountEntryState({ ok: false, status: failure instanceof AuthClientError ? failure.status : 0 })) },
      )
    }
    probe()
    const onFocus = () => { if (document.visibilityState === "visible") probe() }
    window.addEventListener("focus", onFocus)
    return () => { active = false; window.removeEventListener("focus", onFocus) }
  }, [retryCount])

  async function exit() {
    if (pending) return
    setPending(true)
    setError("")
    try {
      await authClient.logout()
      router.replace("/login")
      router.refresh()
    } catch (failure) {
      setError(failure instanceof AuthClientError ? failure.message : "退出失败，请重试。")
    } finally {
      setPending(false)
    }
  }

  if (state.kind === "loading") return null
  if (state.kind === "anonymous") return (
    <Button variant="outline" size="sm" asChild>
      <Link href="/login"><LogInIcon />登录</Link>
    </Button>
  )
  if (state.kind === "unavailable") return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">登录状态不可用</span>
      <Button variant="outline" size="sm" onClick={() => setRetryCount(count => count + 1)}>重试</Button>
    </div>
  )
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{state.username}</span>
      <Button variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={() => void exit()}>
        <LogOutIcon />{pending ? "正在退出" : "退出登录"}
      </Button>
      <FieldError aria-live="polite">{error}</FieldError>
    </div>
  )
}
