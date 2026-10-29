import assert from "node:assert/strict"
import { test } from "node:test"
import { canonicalJson, ResultValidatorRegistry } from "./validation"

test("operation hashes distinguish values but ignore object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: "1.20" }), canonicalJson({ a: "1.20", b: 2 }))
  assert.notEqual(canonicalJson({ a: "1.20" }), canonicalJson({ a: "1.2" }))
})
test("unregistered production result types fail closed", () => {
  assert.throws(() => new ResultValidatorRegistry().require("fixture"), { code: "SERVICE_UNAVAILABLE" })
})
