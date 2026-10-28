import { isAbsolute } from "node:path"
import { AuthService } from "../src/server/auth/service"
import { AuthError } from "../src/server/auth/errors"
import { connectDatabase } from "../src/server/database/connection"
import { migrateBusiness } from "../src/server/database/migrations"

// Private server maintenance only. No password arguments or automatic accounts.
let db: Awaited<ReturnType<typeof connectDatabase>> | undefined
try {
  const [action, nameFlag, username, actorFlag, actor, ...extra] = process.argv.slice(2)
  if (!["create", "reset", "disable", "enable"].includes(action) || nameFlag !== "--username" || !username || actorFlag !== "--actor" || !actor || extra.length) {
    throw new Error("Invalid arguments")
  }
  let password: string | undefined
  if (action === "create" || action === "reset") {
    if (process.stdin.isTTY) throw new Error("Private stdin required")
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 514) throw new Error("Password input too large")
      chunks.push(bytes)
    }
    password = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, "")
  }
  try { process.loadEnvFile(".env.local") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (!["sqlite", "gaussdb"].includes(process.env.DATABASE_PROVIDER ?? "")) throw new Error("Explicit database provider required")
  if (process.env.DATABASE_PROVIDER === "sqlite" && (!process.env.SQLITE_PATH || !isAbsolute(process.env.SQLITE_PATH))) throw new Error("Absolute SQLite path required")
  db = await connectDatabase()
  await migrateBusiness(db)
  await new AuthService(db).maintain({ action: action as "create" | "reset" | "disable" | "enable", username, actor, password })
  console.log("账号维护完成。")
} catch (error) {
  console.error(error instanceof AuthError ? error.message : "账号维护失败：检查操作参数、私有标准输入及数据库配置。")
  process.exitCode = 1
} finally { await db?.close() }
