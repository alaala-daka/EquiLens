import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Connection, Database } from "../database/connection"
import { AuthError } from "./errors"
import { hashPassword, validPassword, verifyPassword } from "./password"

export type Principal = { id: string; username: string }
export type AccountOperation = { action: "create" | "reset" | "disable" | "enable"; username: string; password?: string; actor: string }
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

  async maintain(input: AccountOperation) {
    const name = username(input.username)
    if (!input.actor.trim() || input.actor.length > 128 || !["create", "reset", "disable", "enable"].includes(input.action)) throw new AuthError("INVALID_INPUT", "账号维护参数无效。")
    const needsPassword = input.action === "create" || input.action === "reset"
    if (needsPassword && (typeof input.password !== "string" || !validPassword(input.password))) throw new AuthError("INVALID_INPUT", "密码长度须为 12—128 个字符。")
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
        else await c.query("UPDATE equilens_auth_accounts SET enabled=$1,revision=revision+1 WHERE id=$2", [input.action === "enable" ? 1 : 0, id])
        await c.query("DELETE FROM equilens_auth_sessions WHERE account_id=$1", [id])
      }
      await c.query("INSERT INTO equilens_auth_audit(id,account_id,action,actor,created_at) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), id, input.action, input.actor, this.now()])
      return { id, username: name }
    })
  }

  async login(rawUsername: string, password: string, source: string) {
    // Bound untrusted input before allocating hashing work or persistent keys.
    if (rawUsername.length > 128 || Buffer.byteLength(password) > 512 || !source.trim() || source.length > 256) throw new AuthError("INVALID_INPUT", "登录参数无效。")
    let name: string
    try { name = username(rawUsername) } catch { throw invalidCredentials() }
    const account = await this.db.transaction(async c => {
      await this.reserve(c, `account:${name}`, 5)
      await this.reserve(c, `source:${source}`, 30)
      return (await c.query("SELECT id,username,password_hash,enabled,revision FROM equilens_auth_accounts WHERE username=$1", [name])).rows[0]
    })
    const valid = await verifyPassword(password, account ? String(account.password_hash) : null)
    if (!valid || !account || Number(account.enabled) !== 1) throw invalidCredentials()
    return this.db.transaction(async c => {
      // Acquire the same row write lock as reset/disable before session insertion.
      const guard = await c.query("UPDATE equilens_auth_accounts SET revision=revision WHERE id=$1 AND enabled=1 AND revision=$2", [String(account.id), Number(account.revision)])
      if (guard.changes !== 1) throw invalidCredentials()
      const token = randomBytes(32).toString("hex")
      const expiresAt = this.now() + 12 * 3600000
      await c.query("INSERT INTO equilens_auth_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,$3)", [sha(token), String(account.id), expiresAt])
      return { token, expiresAt, user: { id: String(account.id), username: name } }
    })
  }

  async current(token: string): Promise<Principal | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null
    return this.db.transaction(async c => {
      const row = (await c.query("SELECT a.id,a.username FROM equilens_auth_accounts a JOIN equilens_auth_sessions s ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND a.enabled=1", [sha(token), this.now()])).rows[0]
      return row ? { id: String(row.id), username: String(row.username) } : null
    })
  }
  async logout(token: string) {
    if (/^[a-f0-9]{64}$/.test(token)) await this.db.transaction(c => c.query("DELETE FROM equilens_auth_sessions WHERE token_hash=$1", [sha(token)]))
  }

  private async reserve(c: Connection, key: string, max: number) {
    const digest = sha(key)
    const now = this.now()
    const row = (await c.query("SELECT window_start,attempts FROM equilens_auth_limits WHERE limit_key=$1", [digest])).rows[0]
    if (!row) {
      await c.query("INSERT INTO equilens_auth_limits(limit_key,window_start,attempts) VALUES ($1,$2,1)", [digest, now])
    } else if (now >= Number(row.window_start) + windowMs) {
      await c.query("UPDATE equilens_auth_limits SET window_start=$1,attempts=1 WHERE limit_key=$2", [now, digest])
    } else {
      const result = await c.query("UPDATE equilens_auth_limits SET attempts=attempts+1 WHERE limit_key=$1 AND window_start=$2 AND attempts<$3", [digest, Number(row.window_start), max])
      if (result.changes !== 1) throw new AuthError("LOGIN_RATE_LIMITED", "登录尝试过多，请稍后重试。")
    }
  }
}
