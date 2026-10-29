import assert from "node:assert/strict"
import { test } from "node:test"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { productionResultValidators } from "./registry"
import { ResultRepository } from "./repository"
import { ResultService, type ResultAuthorizer } from "./service"
import { statements } from "./schema"
import { successResult, validRunnerInput } from "../reviews/test-fixtures"

test("A4c production result registry: contract-review is the only registered kind and unknown kinds fail closed", async () => {
  const registry = productionResultValidators()
  const validator = registry.require("contract-review")
  assert.equal((await validator(successResult(validRunnerInput()))).status, "valid")
  for (const kind of ["test", "contract-review-draft", ""]) {
    assert.throws(() => registry.require(kind), { code: "SERVICE_UNAVAILABLE" })
  }
})

test("A4c production result policy: contract-review human writes are refused", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await database.transaction(async connection => { for (const sql of statements) await connection.query(sql) })
    const identity = { account: { id: "account-1", username: "editor", role: "member" }, session: { id: "session-1", expiresAt: 0 } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_, projectId, action) => ({ projectId, action, role: "editor", identity })
    const service = new ResultService(new ResultRepository(database), productionResultValidators(), new Set(["contract-review"]))
    await assert.rejects(service.saveResultRevision(identity, authorize, {
      projectId: "project-1", kind: "contract-review", baseVersionId: "", operationId: "forged-1",
      reason: "人工伪造", value: successResult(validRunnerInput()), sources: [], dependencies: [],
    }), { code: "FORBIDDEN" })
  } finally { await database.close() }
})
