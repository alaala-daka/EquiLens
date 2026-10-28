import { connectDatabase } from "../../../../src/server/database/connection"
import { migrateBusiness } from "../../../../src/server/database/migrations"
import { AuthService } from "../../../../src/server/auth/service"
async function main() {
  const db = await connectDatabase({ provider: "sqlite", path: process.env.SQLITE_PATH! })
  try {
    await migrateBusiness(db)
    const service = new AuthService(db)
    const action = process.argv[2]
    if (action === "seed") {
      for (const username of ["synthetic.api", "synthetic.browser"]) await service.maintain({ action: "create", username, password: "Synthetic browser password!", actor: "isolated-task8" })
    } else if (action === "expire") {
      await db.transaction(c => c.query("UPDATE equilens_auth_sessions SET expires_at=$1", [Date.now() - 1000]))
    } else if (action === "disable" || action === "enable") {
      await service.maintain({ action, username: "synthetic.browser", actor: "isolated-task8" })
    }
    console.log(`Synthetic database operation: ${action} OK`)
  } finally { await db.close() }
}
main().catch(() => { console.error("Synthetic database operation failed"); process.exitCode = 1 })
