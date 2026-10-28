import assert from "node:assert/strict"
import { test } from "node:test"
import { transform } from "esbuild"
import { readFile } from "node:fs/promises"
import { AuthError, isAuthError } from "./errors"

test("AUTH-01: auth errors survive separate server bundles without trusting unbranded data", async () => {
  const source = await readFile(new URL("./errors.ts", import.meta.url), "utf8")
  const { code } = await transform(source, { loader: "ts", format: "esm" })
  const other = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
  const error = new other.AuthError("INVALID_CREDENTIALS", "never expose")
  assert.equal(error instanceof AuthError, false)
  assert.equal(isAuthError(error), true)
  for (const value of [null, {}, new Error("private"), { code: "INVALID_CREDENTIALS" }, { [Symbol.for("equilens.auth.error")]: true, code: "UNKNOWN" }]) assert.equal(isAuthError(value), false)
})
