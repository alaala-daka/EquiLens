import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { AuthService } from "./service"

const tsx = resolve("node_modules/tsx/dist/cli.mjs")
const script = resolve("scripts/manage-account.mts")

test("AC-01 / AUTH-03: private maintenance selects an explicit database and revokes old sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-auth-cli-"))
  const path = join(directory, "cli.sqlite")
  const password = "Synthetic CLI password!"
  const replacement = "Synthetic replacement password!"
  // Deliberately isolate cwd: never load, alter or remove the developer's .env.local.
  async function runWithEnv(env: NodeJS.ProcessEnv, action = "create", extra: string[] = [], input = password + "\n") {
    const child = spawn(process.execPath, [tsx, script, action, "--username", "operator", "--actor", "test-admin", ...extra], {
      cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", data => { output += data })
    child.stderr.on("data", data => { output += data })
    const completed = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done) })
    child.stdin.on("error", () => {}) // Early rejection may close stdin before its write.
    child.stdin.end(input)
    const code = await completed
    for (const secret of [password, replacement]) assert.equal(output.includes(secret), false)
    return code
  }
  const baseEnv: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_PROVIDER|SQLITE_PATH|GAUSSDB_.*)$/i.test(key))), NODE_ENV: process.env.NODE_ENV }
  const configured = { ...baseEnv, DATABASE_PROVIDER: "sqlite", SQLITE_PATH: path }
  try {
    assert.notEqual(await runWithEnv({ ...configured, SQLITE_PATH: "relative.sqlite" }), 0, "relative path")
    assert.notEqual(await runWithEnv({ ...baseEnv, SQLITE_PATH: path }), 0, "missing provider")
    assert.notEqual(await runWithEnv({ ...configured, DATABASE_PROVIDER: "unknown" }), 0, "unknown provider")
    assert.notEqual(await runWithEnv({ ...baseEnv, DATABASE_PROVIDER: "sqlite" }), 0, "missing path")
    // The forbidden flag is rejected without placing a password in subprocess argv.
    assert.notEqual(await runWithEnv(configured, "create", ["--password"]), 0)
    assert.equal(await runWithEnv(configured), 0)
    assert.notEqual(await runWithEnv(configured), 0, "duplicate account")
    const db = await connectDatabase({ provider: "sqlite", path })
    try {
      const rows = (await db.transaction(c => c.query("SELECT password_hash FROM equilens_auth_accounts"))).rows
      assert.equal(rows.length, 1)
      assert.match(String(rows[0].password_hash), /^scrypt-v1\$/)
      assert.equal(String(rows[0].password_hash).includes(password), false)
      const service = new AuthService(db)
      const first = await service.login("operator", password, "maintenance-test")
      assert.equal(await runWithEnv(configured, "disable", [], ""), 0)
      assert.equal(await service.session(first.token), null)
      assert.equal(await runWithEnv(configured, "enable", [], ""), 0)
      assert.equal(await service.session(first.token), null)
      const second = await service.login("operator", password, "maintenance-test")
      assert.equal(await runWithEnv(configured, "reset", [], replacement), 0)
      assert.equal(await service.session(second.token), null)
      await assert.rejects(service.login("operator", password, "maintenance-test"))
      assert.ok(await service.login("operator", replacement, "maintenance-test"))
    } finally { await db.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
