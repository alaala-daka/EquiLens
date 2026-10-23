import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"

test("AC-01: private CLI accepts stdin, refuses password arguments and stores only a hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-auth-cli-"))
  const path = join(directory, "cli.sqlite")
  const password = "Synthetic CLI password!"
  async function run(extra: string[], input = "") {
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/manage-account.mts", "create", "--username", "operator", "--actor", "test-admin", ...extra], {
      env: { ...process.env, DATABASE_PROVIDER: "sqlite", SQLITE_PATH: path }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", data => { output += data })
    child.stderr.on("data", data => { output += data })
    const completed = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done) })
    child.stdin.end(input)
    const code = await completed
    assert.equal(output.includes(password), false)
    return code
  }
  try {
    assert.equal(await run(["--password", password]), 1)
    assert.equal(await run([], password + "\n"), 0)
    assert.equal(await run([], password), 1)
    const db = await connectDatabase({ provider: "sqlite", path })
    try {
      const rows = (await db.transaction(c => c.query("SELECT password_hash FROM equilens_auth_accounts"))).rows
      assert.equal(rows.length, 1)
      assert.match(String(rows[0].password_hash), /^scrypt-v1\$/)
      assert.equal(String(rows[0].password_hash).includes(password), false)
    } finally { await db.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
