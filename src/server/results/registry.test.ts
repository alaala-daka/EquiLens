import assert from "node:assert/strict"
import { test } from "node:test"
import { productionResultValidators } from "./registry"
import { successResult, validRunnerInput } from "../reviews/test-fixtures"

test("A4c production result registry: contract-review is the only registered kind and unknown kinds fail closed", async () => {
  const registry = productionResultValidators()
  const validator = registry.require("contract-review")
  assert.equal((await validator(successResult(validRunnerInput()))).status, "valid")
  for (const kind of ["test", "contract-review-draft", ""]) {
    assert.throws(() => registry.require(kind), { code: "SERVICE_UNAVAILABLE" })
  }
})
