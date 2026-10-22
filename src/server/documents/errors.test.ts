import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { transform } from "esbuild"
import { StoreError, SessionRegistrationRace, sessionTransaction } from "./errors"
import { failureResponse } from "./http"

test("DB-04/DB-08: independent server bundles share error constructors; unknown faults remain private", async () => {
  const source = await readFile("src/server/documents/errors.ts", "utf8")
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "node24" })
  const load = (suffix: string) => import(`data:text/javascript;base64,${Buffer.from(code + suffix).toString("base64")}`)
  const instrumentation = await load("\n// instrumentation bundle"), route = await load("\n// route bundle")
  assert.equal(instrumentation.StoreError, StoreError)
  assert.equal(route.StoreError, StoreError)
  assert.equal(instrumentation.SessionRegistrationRace, SessionRegistrationRace)
  assert.equal(route.SessionRegistrationRace, SessionRegistrationRace)
  const missing = failureResponse(new instrumentation.StoreError(404, "文档不存在。"))
  assert.equal(missing.status, 404)
  const expired = failureResponse(new instrumentation.StoreError(410, "已到期", "RETENTION_EXPIRED"))
  assert.equal(expired.status, 410)
  assert.equal((await expired.json()).code, "RETENTION_EXPIRED")
  for (const fault of [new Error("SECRET SQL"), { status: 404, message: "SECRET", code: "RETENTION_EXPIRED" }]) {
    const response = failureResponse(fault)
    assert.equal(response.status, 503)
    assert.doesNotMatch(JSON.stringify(await response.json()), /SECRET/)
  }
  let attempts = 0
  const database = { async close() {}, async transaction<T>(): Promise<T> { if (++attempts === 1) throw new instrumentation.SessionRegistrationRace(); return "retried" as T } }
  assert.equal(await sessionTransaction(database, async () => "unused"), "retried")
  assert.equal(attempts, 2)
})
