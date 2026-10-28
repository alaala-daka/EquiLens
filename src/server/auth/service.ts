import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Database } from "../database/connection"
import { AuthError } from "./errors"
import { hashPassword, validPassword, verifyPassword } from "./password"

export type Account = { id: string; username: string; role: "member" | "superadmin" }
export type Principal = Account
export type AuthIdentity = { account: Account; session: { id: string; expiresAt: number } }
export type SessionView = { user: Account; expiresAt: string }
export type LoginResult = { token: string; expiresAt: number; user: Account }
export type AccountOperation = { action: "create" | "reset" | "disable" | "enable" | "grant-admin" | "revoke-admin"; username: string; password?: string; actor: string }
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const windowMs = 15 * 60000
function username(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) throw new AuthError("INVALID_INPUT", "账号格式无效。")
  return normalized
}
const invalidCredentials = () => new AuthError("INVALID_CREDENTIALS", "账号或密码错误。")

/** Server-internal primitive. HTTP consumers must enter through the server-only boundary. */
export class AuthService {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  async bootstrapAdmin(rawUsername: string, password: string): Promise<void> {
    const name = username(rawUsername)
    if (typeof password !== "string" || !validPassword(password)) throw new AuthError("INVALID_INPUT", "密码长度须为 12—128 个字符。")
    if (await this.db.transaction(async c => (await c.query("SELECT id FROM equilens_auth_bootstrap WHERE id=1")).rows.length > 0)) return
    const encoded = await hashPassword(password)
    await this.db.transaction(async c => {
      if ((await c.query("SELECT id FROM equilens_auth_bootstrap WHERE id=1")).rows.length) return
      // Reserve the unique marker first; concurrent losers roll back and remain unready.
      await c.query("INSERT INTO equilens_auth_bootstrap(id) VALUES (1)")
      if ((await c.query("SELECT id FROM equilens_auth_accounts WHERE username=$1", [name])).rows.length) throw new AuthError("ACCOUNT_CONFLICT", "账号已存在。")
      const id = randomUUID()
      await c.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES ($1,$2,$3,1,1,'superadmin')", [id, name, encoded])
      await c.query("INSERT INTO equilens_auth_audit(id,account_id,action,actor,created_at) VALUES ($1,$2,'bootstrap','deployment',$3)", [randomUUID(), id, this.now()])
    })
  }

  async maintain(input: AccountOperation) {
    const name = username(input.username)
    if (!input.actor.trim() || input.actor.length > 128 || !["create", "reset", "disable", "enable", "grant-admin", "revoke-admin"].includes(input.action)) throw new AuthError("INVALID_INPUT", "账号维护参数无效。")
    const needsPassword = input.action === "create" || input.action === "reset"
    if (needsPassword && (typeof input.password !== "string" || !validPassword(input.password))) throw new AuthError("INVALID_INPUT", "密码长度须为 12—128 个字符。")
    if (!needsPassword && input.password !== undefined) throw new AuthError("INVALID_INPUT", "此操作不接受密码。")
    const encoded = needsPassword ? await hashPassword(input.password!) : null
    return this.db.transaction(async c => {
      const account = (await c.query("SELECT id FROM equilens_auth_accounts WHERE username=$1", [name])).rows[0]
      if (input.action === "create" && account) throw new AuthError("ACCOUNT_CONFLICT", "账号已存在。")
      if (input.action !== "create" && !account) throw new AuthError("ACCOUNT_NOT_FOUND", "账号不存在。")
      const id = account ? String(account.id) : randomUUID()
      if (input.action === "create") {
        await c.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision) VALUES ($1,$2,$3,1,1)", [id, name, encoded])
      } else {
        if (input.action === "reset") await c.query("UPDATE equilens_auth_accounts SET password_hash=$1,revision=revision+1 WHERE id=$2", [encoded, id])
        else if (input.action === "grant-admin" || input.action === "revoke-admin") await c.query("UPDATE equilens_auth_accounts SET role=$1,revision=revision+1 WHERE id=$2", [input.action === "grant-admin" ? "superadmin" : "member", id])
        else await c.query("UPDATE equilens_auth_accounts SET enabled=$1,revision=revision+1 WHERE id=$2", [input.action === "enable" ? 1 : 0, id])
        await c.query("DELETE FROM equilens_auth_sessions WHERE account_id=$1", [id])
      }
      await c.query("INSERT INTO equilens_auth_audit(id,account_id,action,actor,created_at) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), id, input.action, input.actor, this.now()])
      return { id, username: name }
    })
  }

  async login(rawUsername: string, password: string, source: string, previousToken?: string): Promise<LoginResult> {
    if (typeof rawUsername !== "string" || typeof password !== "string" || typeof source !== "string" || !source.trim() || source.length > 256) throw new AuthError("INVALID_INPUT", "登录参数无效。")
    // Source accounting commits independently, even for invalid credentials or account rejection.
    await this.reserve(`source:${source}`, 30)
    if (rawUsername.length > 128 || password.length > 512 || Buffer.byteLength(password) > 512 || Array.from(password).length > 128) throw new AuthError("INVALID_INPUT", "登录参数无效。")
    let name: string
    try { name = username(rawUsername) } catch { throw invalidCredentials() }
    await this.reserve(`account:${name}`, 5)
    const account = await this.db.transaction(async c =>
      (await c.query("SELECT id,username,password_hash,enabled,revision FROM equilens_auth_accounts WHERE username=$1", [name])).rows[0])
    const valid = await verifyPassword(password, account ? String(account.password_hash) : null)
    if (!valid || !account || Number(account.enabled) !== 1) throw invalidCredentials()
    return this.db.transaction(async c => {
      // Acquire the same row write lock as reset/disable before session insertion.
      const guard = await c.query("UPDATE equilens_auth_accounts SET revision=revision WHERE id=$1 AND enabled=1 AND revision=$2", [String(account.id), Number(account.revision)])
      if (guard.changes !== 1) throw invalidCredentials()
      const current = (await c.query("SELECT role FROM equilens_auth_accounts WHERE id=$1", [String(account.id)])).rows[0]
      const role = accountRole(current?.role)
      const token = randomBytes(32).toString("hex")
      const expiresAt = this.now() + 12 * 3600000
      await c.query("INSERT INTO equilens_auth_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,$3)", [sha(token), String(account.id), expiresAt])
      if (previousToken && /^[a-f0-9]{64}$/.test(previousToken)) await c.query("DELETE FROM equilens_auth_sessions WHERE token_hash=$1", [sha(previousToken)])
      return { token, expiresAt, user: { id: String(account.id), username: name, role } }
    })
  }

  async current(token: string): Promise<Principal | null> {
    return (await this.session(token))?.account ?? null
  }

  async session(token: string): Promise<AuthIdentity | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null
    return this.revalidateSession(sha(token))
  }

  async revalidateSession(sessionId: string): Promise<AuthIdentity | null> {
    if (!/^[a-f0-9]{64}$/.test(sessionId)) return null
    return this.db.transaction(async c => {
      const row = (await c.query("SELECT a.id,a.username,a.role,s.expires_at FROM equilens_auth_accounts a JOIN equilens_auth_sessions s ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND a.enabled=1", [sessionId, this.now()])).rows[0]
      return row ? { account: { id: String(row.id), username: String(row.username), role: accountRole(row.role) }, session: { id: sessionId, expiresAt: Number(row.expires_at) } } : null
    })
  }
  async logout(token: string) {
    if (/^[a-f0-9]{64}$/.test(token)) await this.db.transaction(c => c.query("DELETE FROM equilens_auth_sessions WHERE token_hash=$1", [sha(token)]))
  }

  private async reserve(key: string, max: number) {
    const digest = sha(key)
    // Retry whole transactions: unique violations can abort the provider transaction.
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: { retry: boolean; seconds?: number }
      let inserting = false
      try {
        result = await this.db.transaction(async c => {
          const now = this.now()
          const row = (await c.query("SELECT window_start,attempts FROM equilens_auth_limits WHERE limit_key=$1", [digest])).rows[0]
          if (!row) {
            inserting = true
            await c.query("INSERT INTO equilens_auth_limits(limit_key,window_start,attempts) VALUES ($1,$2,1)", [digest, now])
            inserting = false
            return { retry: false }
          }
          const start = Number(row.window_start)
          const count = Number(row.attempts)
          if (now >= start + windowMs) {
            const updated = await c.query("UPDATE equilens_auth_limits SET window_start=$1,attempts=1 WHERE limit_key=$2 AND window_start=$3 AND attempts=$4", [now, digest, start, count])
            return { retry: updated.changes !== 1 }
          }
          if (count >= max) return { retry: false, seconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) }
          const updated = await c.query("UPDATE equilens_auth_limits SET attempts=attempts+1 WHERE limit_key=$1 AND window_start=$2 AND attempts<$3", [digest, start, max])
          return { retry: updated.changes !== 1 }
        })
      } catch (error) {
        const failure = error as { code?: string; errcode?: number }
        if (!inserting || (failure.code !== "23505" && failure.errcode !== 1555 && failure.errcode !== 2067)) throw error
        result = { retry: true }
      }
      if (result.seconds !== undefined) throw new AuthError("LOGIN_RATE_LIMITED", "登录尝试过多，请稍后重试。", result.seconds)
      if (!result.retry) return
    }
    throw new AuthError("AUTH_UNAVAILABLE", "认证服务暂不可用。")
  }
}

function accountRole(value: unknown): Account["role"] {
  if (value !== "member" && value !== "superadmin") throw new AuthError("AUTH_UNAVAILABLE", "认证服务暂不可用。")
  return value
}
