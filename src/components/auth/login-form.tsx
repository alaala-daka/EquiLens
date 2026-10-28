"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authClient, AuthClientError } from "@/lib/auth/client"
import { createLoginController } from "@/lib/auth/login-controller"
import { safeReturnTarget } from "@/lib/auth/return-target"

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const controller = useRef(createLoginController({
    submit: authClient.login,
    onSuccess: () => {
      const target = safeReturnTarget(new URLSearchParams(window.location.search).get("returnTo"), window.location.origin)
      router.replace(target)
      router.refresh()
    },
  }))
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader><CardTitle>登录衡鉴</CardTitle></CardHeader>
        <CardContent>
          <form aria-busy={pending} onSubmit={async (event) => {
            event.preventDefault()
            if (controller.current.pending()) return
            setPending(true)
            setError("")
            try { await controller.current.run(username, password) }
            catch (failure) { setError(failure instanceof AuthClientError ? failure.message : "请求失败，请稍后重试。") }
            finally { setPassword(""); setPending(false) }
          }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">账号</FieldLabel>
                <Input id="username" name="username" type="text" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} disabled={pending} aria-describedby={error ? "login-error" : undefined} aria-invalid={!!error} />
              </Field>
              <Field>
                <div className="flex items-center"><FieldLabel htmlFor="password">密码</FieldLabel></div>
                <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={pending} aria-describedby={error ? "login-error" : undefined} aria-invalid={!!error} />
              </Field>
              <Field>
                <FieldError id="login-error" aria-live="polite">{error}</FieldError>
                <Button type="submit" disabled={pending}>{pending ? "登录中…" : "登录"}</Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
