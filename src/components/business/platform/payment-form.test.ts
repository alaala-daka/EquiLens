import assert from "node:assert/strict"
import { test } from "node:test"
import { paymentFen, paymentYuan, paymentOperation } from "./payment-form"

test("payment form retains exact large and negative amounts without floats", () => {
  for (const [yuan, fen] of [["1000000.00", "100000000"], ["0.03", "3"], ["-0.01", "-1"], ["9007199254740993.01", "900719925474099301"]]) {
    assert.equal(paymentFen(yuan), fen); assert.equal(paymentYuan(fen), yuan)
  }
  for (const raw of ["1e6", "1.001", "1,000", "NaN", ""]) assert.equal(paymentFen(raw), null)
})

test("payment failed-request retries preserve operation id; changed edits use a new id", () => {
  const first = paymentOperation(null, "first", () => "id-1")
  assert.equal(paymentOperation(first, "first", () => "id-2"), first)
  assert.deepEqual(paymentOperation(first, "changed", () => "id-2"), { signature: "changed", id: "id-2" })
})
