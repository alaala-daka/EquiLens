import assert from "node:assert/strict"
import { test } from "node:test"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { productionResultValidators } from "./registry"
import { ResultRepository } from "./repository"
import { ResultService, type ResultAuthorizer } from "./service"
import { statements } from "./schema"
import { successResult, validRunnerInput } from "../reviews/test-fixtures"

test("A4c/R7 production result registry: round-seven kinds are registered and unknown kinds fail closed", async () => {
  const registry = productionResultValidators()
  assert.equal((await registry.require("contract-review")(successResult(validRunnerInput()))).status, "valid")
  for (const kind of ["fact-candidates", "payment-reconciliation", "bid-requirements", "bid-verification", "specialty-subcontract", "supplementary-agreement"]) registry.require(kind)
  for (const kind of ["test", "contract-review-draft", ""]) {
    assert.throws(() => registry.require(kind), { code: "SERVICE_UNAVAILABLE" })
  }
})

test("A4c/R7 production result policy: contract-review is machine-only on creation, human-editable only as a revision", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await database.transaction(async connection => { for (const sql of statements) await connection.query(sql) })
    const identity = { account: { id: "account-1", username: "editor", role: "member" }, session: { id: "session-1", expiresAt: 0 } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_, projectId, action) => ({ projectId, action, role: "editor", identity })
    // Production round-seven policy: contract-review is not machine-only but existingOnly;
    // fact-candidates stays task-written.
    const service = new ResultService(new ResultRepository(database), productionResultValidators(), new Set(["fact-candidates", "payment-reconciliation"]), new Set(["payment-reconciliation"]), new Set(["contract-review"]), new Set(["fact-candidates"]))
    await assert.rejects(service.saveResultRevision(identity, authorize, {
      projectId: "project-1", kind: "contract-review", baseVersionId: "", operationId: "forged-1",
      reason: "人工伪造", value: successResult(validRunnerInput()), sources: [], dependencies: [],
    }), { code: "FORBIDDEN" })
    await assert.rejects(service.saveResultRevision(identity, authorize, {
      projectId: "project-1", kind: "fact-candidates", baseVersionId: "", operationId: "forged-2",
      reason: "人工伪造", value: {}, sources: [], dependencies: [],
    }), { code: "FORBIDDEN" })
  } finally { await database.close() }
})
