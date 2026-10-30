import assert from "node:assert/strict"
import test from "node:test"
import {
  createVerificationsClient,
  VerificationClientError,
  verificationFailureFromResponse,
} from "./verifications-client"
import { DOCX_TYPE } from "../documents/types"

const task = {
  id: "task-1",
  kind: "bid-verification",
  projectId: "project-1",
  state: "queued",
  stage: "submitted",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  attempt: 0,
  maxAttempts: 3,
  callsUsed: 0,
  maxCalls: 0,
  elapsedMs: 0,
  manifest: { version: 1, catalogVersion: 4, kind: "bid-verification", projectId: "project-1", refs: {}, conditions: {}, submittedBy: "account-1", submittedAt: "2026-10-29T00:00:00.000Z" },
  error: null,
  resultSummary: null,
}

const result = {
  projectId: "project-1",
  resultId: "result-1",
  versionId: "version-1",
  sha256: "b".repeat(64),
  kind: "bid-verification",
  value: { schemaVersion: 1 },
  machineOutput: null,
  origin: "machine",
  sources: [],
  dependencies: [],
  provenance: { taskId: "task-1", attempt: 0, manifest: {}, manifestHash: "c".repeat(64) },
  validation: { status: "valid", versionId: "version-1", checkedAt: "2026-10-29T00:00:00.000Z", issues: [] },
  review: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  createdBy: "account-1",
  reason: "",
}

const detail = { result, records: [], stale: { records: false, fields: false, hint: null } }

const field = {
  id: "field-1", materialId: "material-1", versionId: "version-1", subjectKey: "enterprise",
  fieldKey: "subject_name", label: "主体名称", valueText: "示例公司", normalizedValue: "示例公司",
  origin: "manual", support: "pending", sourceSnapshotId: null, sourceFragmentId: null, ocrRunId: null,
  confidence: null, revision: 1, previousId: null, supersededAt: null, reason: null, createdBy: "account-1",
  createdAt: "2026-10-29T00:00:00.000Z",
}

function client(fetcher: typeof fetch, overrides: Partial<Parameters<typeof createVerificationsClient>[0]> = {}) {
  return createVerificationsClient({
    projectId: "project-1",
    isCurrent: () => true,
    canEdit: () => true,
    canManage: () => true,
    fetch: fetcher,
    ...overrides,
  })
}

const requirementsSubmission = {
  kind: "bid-requirements" as const,
  refs: { materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }] },
  conditions: { externalProcessingConsent: true as const, asOf: "2026-10-29" },
}
const comparisonSubmission = {
  kind: "bid-verification" as const,
  refs: {
    materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }],
    requirementSet: { id: "set-1", versionId: "set-version-1", sha256: "d".repeat(64) },
    externalRecords: [{ recordId: "record-1", sha256: "e".repeat(64) }],
  },
  conditions: { asOf: "2026-10-29" },
}

test("C4-UI: task submission sends only the frozen kind/refs/conditions and keeps the idempotency key", async () => {
  const calls: { path: string; init: RequestInit }[] = []
  const instance = client(async (input, init) => {
    calls.push({ path: String(input), init: { ...(init ?? {}) } })
    return Response.json({ task, created: true }, { status: 202 })
  })
  const created = await instance.submitTask(comparisonSubmission, "operation-key-1")
  assert.equal(created.task.id, "task-1")
  assert.equal(created.created, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, "/api/tasks")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.cache, "no-store")
  assert.equal(calls[0].init.credentials, "same-origin")
  assert.equal((calls[0].init.headers as Record<string, string>)["Idempotency-Key"], "operation-key-1")
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    kind: "bid-verification",
    projectId: "project-1",
    refs: comparisonSubmission.refs,
    conditions: comparisonSubmission.conditions,
  })
})

test("C4-UI: read-only member never sends writes but may revalidate", async () => {
  const writes: string[] = []
  const instance = client(async (input, init) => {
    const path = String(input)
    if (init?.method === "POST" && !path.endsWith("/validate")) writes.push(path)
    if (path.endsWith("/validate")) return Response.json(result.validation)
    throw new Error(`unexpected request ${path}`)
  }, { canEdit: () => false })
  const ref = { resultId: "result-1", versionId: "version-1", sha256: "b".repeat(64) }
  await assert.rejects(instance.submitTask(requirementsSubmission, "op"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.saveRequirementSet({ baseVersionId: "", operationId: "op", reason: "理由", value: { schemaVersion: 1, status: "candidate", requirements: [], rejected: [], warnings: [], errors: [] } }), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.registerFields("material-1", "version-1", { operationId: "op", fields: [] }), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.appendExternalRecord("result-1", { versionId: "version-1", sha256: "b".repeat(64), requirementId: "R1", subject: "s", certificateNo: "c", source: "s", queriedAt: "t", queryConditions: "q", conclusion: "matched", proofMaterialVersionId: "version-1" }), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.reviewResult({ ...ref, decision: "approved", comment: "" }), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.createExport(ref), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  assert.deepEqual(writes, [])
  assert.equal((await instance.validateResult(ref)).status, "valid")
  assert.deepEqual(writes, [])
})

test("C4-UI: HTTP failures map to shared codes and preserve safe server messages", () => {
  const mapped = verificationFailureFromResponse(409, { error: { code: "CONFLICT", message: "成果版本已变化，请重新读取后保存。" } })
  assert.equal(mapped.code, "CONFLICT")
  assert.equal(mapped.status, 409)
  assert.equal(mapped.serverCode, "CONFLICT")
  assert.equal(mapped.message, "成果版本已变化，请重新读取后保存。")
  for (const [status, code] of [
    [400, "INVALID"], [401, "SESSION_INVALID"], [403, "ACCESS_DENIED"], [404, "NOT_FOUND"],
    [413, "INVALID"], [422, "INVALID"], [429, "RATE_LIMITED"], [503, "UNAVAILABLE"],
  ] as const) {
    assert.equal(verificationFailureFromResponse(status, null).code, code)
  }
  const hostile = verificationFailureFromResponse(503, { error: { message: "<script>alert(1)</script>" } })
  assert.equal(hostile.code, "UNAVAILABLE")
  assert.equal(hostile.message, "服务暂不可用，请稍后重试。")
  assert.equal(verificationFailureFromResponse(418, null).code, "FAILED")
})

test("C4-UI: access failures notify the workspace; other failures do not", async () => {
  const notified: string[] = []
  for (const status of [401, 403, 409, 503]) {
    const instance = client(async () => Response.json({ error: { code: "CONFLICT", message: "冲突" } }, { status }),
      { onAccessInvalid: failure => notified.push(failure.code) })
    await assert.rejects(instance.listVerifications(), (failure: unknown) => failure instanceof VerificationClientError)
  }
  assert.deepEqual(notified, ["SESSION_INVALID", "ACCESS_DENIED"])
})

test("C4-UI: a late response after project switch or unmount is rejected", async () => {
  let current = true
  const instance = client(async () => {
    current = false
    return Response.json({ items: [] })
  }, { isCurrent: () => current })
  await assert.rejects(instance.listVerifications(), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ABORTED")
  const calls: string[] = []
  const stale = client(async input => { calls.push(String(input)); return Response.json({ items: [] }) }, { isCurrent: () => false })
  await assert.rejects(stale.listVerifications(), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ABORTED")
  assert.deepEqual(calls, [])
})

test("C4-UI: one failing external send is a single attempt, never an automatic retry", async () => {
  let calls = 0
  const instance = client(async () => {
    calls++
    return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "该任务类型尚未开放。" } }, { status: 503 })
  })
  await assert.rejects(instance.submitTask(comparisonSubmission, "op"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "UNAVAILABLE" && failure.message === "该任务类型尚未开放。")
  assert.equal(calls, 1)
})

test("C4-UI: verification reads use the existing paths", async () => {
  const requests: string[] = []
  const instance = client(async input => {
    const path = String(input)
    requests.push(path)
    if (path.endsWith("/materials")) return Response.json({ materials: [{ id: "material-1" }] })
    if (path.includes("/verifications/") && !path.endsWith("/verifications")) return Response.json(detail)
    if (path.endsWith("/verifications")) return Response.json({ items: [{ resultId: "result-1", kind: "bid-verification" }] })
    if (path.includes("?projectId=")) return Response.json({ tasks: [task] })
    if (path === "/api/tasks/task-1") return Response.json(task)
    return Response.json(result)
  })
  assert.equal((await instance.listMaterials())[0].id, "material-1")
  assert.equal((await instance.listTasks())[0].kind, "bid-verification")
  assert.equal((await instance.getTask("task-1")).state, "queued")
  assert.equal((await instance.listVerifications())[0].kind, "bid-verification")
  assert.equal((await instance.getVerification("result-1")).result.resultId, "result-1")
  assert.deepEqual(requests, [
    "/api/projects/project-1/materials",
    "/api/tasks?projectId=project-1",
    "/api/tasks/task-1",
    "/api/projects/project-1/verifications",
    "/api/projects/project-1/verifications/result-1",
  ])
})

test("C4-UI: requirement/field/record writes use the frozen bodies", async () => {
  const requests: { path: string; body: unknown; method: string }[] = []
  const instance = client(async (input, init) => {
    const path = String(input)
    requests.push({ path, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path.endsWith("/requirements")) return Response.json(result)
    if (path.endsWith("/external-records")) return Response.json({ recordId: "record-1", sha256: "e".repeat(64) })
    if (path.endsWith("/fields") && init?.method === "POST") return Response.json({ fields: [field] })
    if (path.endsWith("/fields")) return Response.json({ fields: [field], history: [] })
    return Response.json(result)
  })
  const value = { schemaVersion: 1 as const, status: "candidate" as const, requirements: [], rejected: [], warnings: [], errors: [] }
  await instance.saveRequirementSet({ resultId: "result-1", baseVersionId: "version-1", operationId: "op-1", reason: "人工确认", value })
  await instance.appendExternalRecord("result-1", { versionId: "version-1", sha256: "b".repeat(64), requirementId: "R1", subject: "示例公司", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T00:00:00.000Z", queryConditions: "条件", conclusion: "matched", proofMaterialVersionId: "version-1" })
  assert.deepEqual((await instance.listFields("material-1", "version-1")).fields[0].fieldKey, "subject_name")
  await instance.registerFields("material-1", "version-1", { operationId: "op-2", reason: "更正理由", fields: [{ fieldKey: "subject_name", valueText: "示例公司", sourceFragmentId: "fragment-1" }] })
  assert.deepEqual(requests.map(item => [item.path, item.method]), [
    ["/api/projects/project-1/verifications/requirements", "POST"],
    ["/api/projects/project-1/verifications/result-1/external-records", "POST"],
    ["/api/projects/project-1/materials/material-1/versions/version-1/fields", "GET"],
    ["/api/projects/project-1/materials/material-1/versions/version-1/fields", "POST"],
  ])
  assert.deepEqual(requests[0].body, { resultId: "result-1", baseVersionId: "version-1", operationId: "op-1", reason: "人工确认", value })
  assert.equal(requests[2].body, null)
  assert.deepEqual(requests[3].body, { operationId: "op-2", reason: "更正理由", fields: [{ fieldKey: "subject_name", valueText: "示例公司", sourceFragmentId: "fragment-1" }] })
})

test("C4-UI: validate/review/exports consume the result paths; downloads validate DOCX bytes", async () => {
  const requests: { path: string; method: string }[] = []
  const instance = client(async (input, init) => {
    const path = String(input)
    requests.push({ path, method: String(init?.method) })
    if (path.endsWith("/validate")) return Response.json(result.validation)
    if (path.endsWith("/review")) return Response.json({ ...result, review: { versionId: "version-1", decision: "approved", comment: "已复核", reviewedBy: "a", reviewedAt: "t" } })
    if (path.endsWith("/exports") && init?.method === "POST") return Response.json({ ...result, exportId: "export-1", format: "docx" }, { status: 201 })
    if (path.endsWith("/exports")) return Response.json([{ exportId: "export-0", format: "docx", createdAt: "2026-10-29T00:00:00.000Z" }])
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": DOCX_TYPE } })
  })
  const ref = { resultId: "result-1", versionId: "version-1", sha256: "b".repeat(64) }
  assert.equal((await instance.validateResult(ref)).status, "valid")
  assert.equal((await instance.reviewResult({ ...ref, decision: "approved", comment: "已复核" })).review?.decision, "approved")
  assert.equal((await instance.listExports("result-1")).length, 1)
  assert.equal((await instance.createExport(ref)).exportId, "export-1")
  assert.equal((await instance.downloadExport("result-1", "export-0")).size, 3)
  assert.deepEqual(requests.map(item => item.method), ["POST", "POST", "GET", "POST", "GET"])
})

test("C4-UI: invalid export bytes surface as a real failure", async () => {
  const html = client(async () => new Response("not docx", { headers: { "Content-Type": "text/html" } }))
  await assert.rejects(html.downloadExport("result-1", "export-1"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "UNAVAILABLE")
  const empty = client(async () => new Response(new Uint8Array(), { headers: { "Content-Type": DOCX_TYPE } }))
  await assert.rejects(empty.downloadExport("result-1", "export-1"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "UNAVAILABLE")
})

test("C4-UI: admin budget endpoints are refused locally for non-administrators", async () => {
  let calls = 0
  const instance = client(async () => { calls++; return Response.json({ budget: null }) }, { canManage: () => false, canEdit: () => false })
  await assert.rejects(instance.getBudget(), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.registerBudget(100), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "ACCESS_DENIED")
  assert.equal(calls, 0)
  const admin = client(async () => Response.json({ budget: { projectId: "project-1", costLimitFen: 100, costReservedFen: 0, costChargedFen: 0, remainingFen: 100, registeredBy: "a", registeredAt: "t", updatedAt: "t", revision: 1 } }))
  assert.equal((await admin.getBudget())?.remainingFen, 100)
  const created = client(async () => Response.json({ budget: { projectId: "project-1", costLimitFen: 200, costReservedFen: 0, costChargedFen: 0, remainingFen: 200, registeredBy: "a", registeredAt: "t", updatedAt: "t", revision: 2 } }))
  assert.equal((await created.registerBudget(200)).costLimitFen, 200)
})

test("C4-UI: a mixed project task list filters unrelated kinds instead of failing the workspace", async () => {
  const materialParse = { ...task, id: "task-parse", kind: "material-parse" }
  const contractReview = { ...task, id: "task-review", kind: "contract-review" }
  const instance = client(async () => Response.json({ tasks: [materialParse, task, contractReview] }))
  const rows = await instance.listTasks()
  assert.deepEqual(rows.map(row => row.id), ["task-1"], "only C4 task kinds are returned")
  assert.deepEqual(rows.map(row => row.kind), ["bid-verification"])
  // getTask stays strict: the UI only references C4 task ids it received from the filtered list.
  const strict = client(async () => Response.json(materialParse))
  await assert.rejects(strict.getTask("task-parse"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "FAILED")
})

test("C4-UI: malformed response bodies are reported without leaking them", async () => {
  const instance = client(async () => new Response("private-project-payload", { status: 200, headers: { "Content-Type": "application/json" } }))
  await assert.rejects(instance.listTasks(), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "FAILED" && !failure.message.includes("private-project-payload"))
  const shape = client(async () => Response.json({ items: "not-an-array" }))
  await assert.rejects(shape.listVerifications(), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "FAILED")
  const detailShape = client(async () => Response.json({ result: { kind: "bid-verification" } }))
  await assert.rejects(detailShape.getVerification("result-1"), (failure: unknown) => failure instanceof VerificationClientError && failure.code === "FAILED")
})
