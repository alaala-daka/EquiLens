import { AuthError } from "./errors"
import type { AuthService } from "./service"

/** Explicit runtime initialization only; no environment reads at import time. */
export async function bootstrapAdmin(auth: AuthService, env: NodeJS.ProcessEnv): Promise<void> {
  const name = env.BOOTSTRAP_ADMIN_USERNAME
  const password = env.BOOTSTRAP_ADMIN_PASSWORD
  if (name === undefined && password === undefined) return
  if (name === undefined || password === undefined || !name.trim() || !password) throw new AuthError("INVALID_INPUT", "管理员初始化配置无效。")
  await auth.bootstrapAdmin(name, password)
}
