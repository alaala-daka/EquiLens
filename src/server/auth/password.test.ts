import assert from "node:assert/strict"
import { test } from "node:test"
import { hashPassword, validPassword, verifyPassword } from "./password"

test("AC-01: passwords retain spaces, use random salts and reject corrupt encodings", async () => {
  const password = "  synthetic password  "
  const first = await hashPassword(password)
  assert.notEqual(first, await hashPassword(password))
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword(password.trim(), first), false)
  assert.equal(await verifyPassword(password, "scrypt-v1$invalid$hash"), false)
  assert.equal(await verifyPassword(password, first.replace("scrypt-v1", "scrypt-v999")), false)
  for (const invalid of ["short", "a".repeat(129)]) {
    assert.equal(validPassword(invalid), false)
    await assert.rejects(hashPassword(invalid))
  }
  assert.equal(validPassword("中".repeat(12)), true)
})
