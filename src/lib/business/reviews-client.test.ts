import assert from "node:assert/strict"
import test from "node:test"
import {
  createProjectReviewsClient,
  ProjectReviewError,
  reviewFailureFromResponse,
} from "./reviews-client"
import { DOCX_TYPE } from "../documents/types"

const task = {
  id: "task-1",
  kind: "contract-review",
  projectId: "project-1",
  state: "queued",
  stage: "submitted",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  attempt: 0,
  maxAttempts: 3,
  callsUsed: 0,
  maxCalls: 25,
  elapsedMs: 0,
  manifest: {
    version: 1,
    catalogVersion: 2,
    kind: "contract-review",
    projectId: "project-1",
    refs: { materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }] },
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
    submittedBy: "account-1",
    submittedAt: "2026-10-29T00:00:00.000Z",
  },
  error: null,
  resultSummary: null,
}

const result = {
  projectId: "project-1",
  resultId: "result-1",
  versionId: "version-1",
  sha256: "b".repeat(64),
  kind: "contract-review",
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

function client(fetcher: typeof fetch, overrides: Partial<Parameters<typeof createProjectReviewsClient>[0]> = {}) {
  return createProjectReviewsClient({
    projectId: "project-1",
    isCurrent: () => true,
    canEdit: () => true,
    fetch: fetcher,
    ...overrides,
  })
}

test("B2a: submission sends the frozen kind/refs/conditions and keeps the idempotency key", async () => {
  const calls: { path: string; init: RequestInit }[] = []
  const instance = client(async (input, init) => {
    calls.push({ path: String(input), init: { ...(init ?? {}) } })
    return Response.json({ task, created: true }, { status: 202 })
  })
  const created = await instance.submitReview({
    materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }],
    conditions: {
      scene: "mep-sub-2026",
      role: "专业分包人",
      region: "上海",
      externalProcessingConsent: true,
      unreviewedMaterialsConsent: true,
    },
  }, "operation-key-1")
  assert.equal(created.task.id, "task-1")
  assert.equal(created.task.state, "queued")
  assert.equal(created.created, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, "/api/tasks")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.cache, "no-store")
  assert.equal(calls[0].init.credentials, "same-origin")
  assert.deepEqual((calls[0].init.headers as Record<string, string>)["Idempotency-Key"], "operation-key-1")
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    kind: "contract-review",
    projectId: "project-1",
    refs: { materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }] },
    conditions: {
      scene: "mep-sub-2026",
      role: "专业分包人",
      region: "上海",
      externalProcessingConsent: true,
      unreviewedMaterialsConsent: true,
    },
  })
})

test("B2a: read-only member never sends submit/review/export writes but may revalidate", async () => {
  const writes: string[] = []
  const instance = client(async (input, init) => {
    const path = String(input)
    if (init?.method === "POST" && !path.endsWith("/validate")) writes.push(path)
    if (path.endsWith("/validate")) return Response.json(result.validation)
    throw new Error(`unexpected request ${path}`)
  }, { canEdit: () => false })
  const submission = {
    materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }],
    conditions: { scene: "auto" as const, role: "专业分包人" as const, region: "上海", externalProcessingConsent: true as const, unreviewedMaterialsConsent: true },
  }
  await assert.rejects(instance.submitReview(submission, "operation-key-1"), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.reviewResult({ ...result, decision: "approved", comment: "" }), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.createExport(result), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "ACCESS_DENIED")
  assert.deepEqual(writes, [])
  assert.equal((await instance.validateResult(result)).status, "valid")
  assert.deepEqual(writes, [])
})

test("B2a: HTTP failures map to the shared codes and preserve safe server messages", () => {
  const mapped = reviewFailureFromResponse(409, { error: { code: "CONFLICT", message: "成果版本已变化，请重新读取后保存。" } })
  assert.equal(mapped.code, "CONFLICT")
  assert.equal(mapped.status, 409)
  assert.equal(mapped.serverCode, "CONFLICT")
  assert.equal(mapped.message, "成果版本已变化，请重新读取后保存。")
  for (const [status, code] of [
    [400, "INVALID"], [401, "SESSION_INVALID"], [403, "ACCESS_DENIED"], [404, "NOT_FOUND"],
    [413, "INVALID"], [422, "INVALID"], [429, "RATE_LIMITED"], [503, "UNAVAILABLE"],
  ] as const) {
    assert.equal(reviewFailureFromResponse(status, null).code, code)
  }
  // A malformed or hostile body must not be echoed as the product message.
  const fallback = reviewFailureFromResponse(503, { error: { message: "<script>alert(1)</script>" } })
  assert.equal(fallback.code, "UNAVAILABLE")
  assert.equal(fallback.message, "服务暂不可用，请稍后重试。")
})

test("B2a: access failures notify the workspace; other failures do not", async () => {
  const notified: string[] = []
  for (const status of [401, 403, 409, 503]) {
    const instance = client(async () => Response.json({ error: { code: "CONFLICT", message: "冲突" } }, { status }),
      { onAccessInvalid: failure => notified.push(failure.code) })
    await assert.rejects(instance.listResults(), (failure: unknown) => failure instanceof ProjectReviewError)
  }
  assert.deepEqual(notified, ["SESSION_INVALID", "ACCESS_DENIED"])
})

test("B2a: a late response after project switch is rejected and never resolves", async () => {
  let current = true
  const instance = client(async () => {
    current = false
    return Response.json([result])
  }, { isCurrent: () => current })
  await assert.rejects(instance.listResults(), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "ABORTED")
  const calls: string[] = []
  const stale = client(async input => { calls.push(String(input)); return Response.json([]) }, { isCurrent: () => false })
  await assert.rejects(stale.listResults(), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "ABORTED")
  assert.deepEqual(calls, [])
})

test("B2a: one failing write is a single attempt, never an automatic retry", async () => {
  let calls = 0
  const instance = client(async () => {
    calls++
    return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "该任务类型尚未开放。" } }, { status: 503 })
  })
  await assert.rejects(instance.submitReview({
    materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }],
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
  }, "operation-key-1"), (failure: unknown) => failure instanceof ProjectReviewError &&
    failure.code === "UNAVAILABLE" && failure.message === "该任务类型尚未开放。")
  assert.equal(calls, 1)
})

test("B2a: validate/review/exports consume the existing paths and bodies", async () => {
  const requests: { path: string; body: unknown; method: string }[] = []
  const instance = client(async (input, init) => {
    const path = String(input)
    requests.push({ path, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path.endsWith("/validate")) return Response.json(result.validation)
    if (path.endsWith("/review")) return Response.json({ ...result, review: { versionId: "version-1", decision: "approved", comment: "已复核", reviewedBy: "account-1", reviewedAt: "2026-10-29T01:00:00.000Z" } })
    if (path.endsWith("/exports") && init?.method === "POST") return Response.json({ ...result, exportId: "export-1", format: "docx" }, { status: 201 })
    if (path.endsWith("/exports")) return Response.json([{ projectId: "project-1", resultId: "result-1", versionId: "version-1", sha256: "b".repeat(64), exportId: "export-0", format: "docx", createdAt: "2026-10-29T00:00:00.000Z" }])
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": DOCX_TYPE } })
  })
  const ref = { resultId: "result-1", versionId: "version-1", sha256: "b".repeat(64) }
  await instance.validateResult(ref)
  const reviewed = await instance.reviewResult({ ...ref, decision: "approved", comment: "已复核" })
  assert.equal(reviewed.review?.decision, "approved")
  const created = await instance.createExport(ref)
  assert.equal(created.exportId, "export-1")
  const existing = await instance.listExports("result-1")
  assert.equal(existing.length, 1)
  const blob = await instance.downloadExport("result-1", "export-0")
  assert.equal(blob.size, 3)
  assert.deepEqual(requests.map(item => item.path), [
    "/api/projects/project-1/results/result-1/validate",
    "/api/projects/project-1/results/result-1/review",
    "/api/projects/project-1/results/result-1/exports",
    "/api/projects/project-1/results/result-1/exports",
    "/api/projects/project-1/results/result-1/exports/export-0/content",
  ])
  assert.deepEqual(requests.map(item => item.method), ["POST", "POST", "POST", "GET", "GET"])
  assert.deepEqual(requests[0].body, { versionId: "version-1", sha256: "b".repeat(64) })
  assert.deepEqual(requests[1].body, { versionId: "version-1", sha256: "b".repeat(64), decision: "approved", comment: "已复核" })
  assert.deepEqual(requests[2].body, { versionId: "version-1", sha256: "b".repeat(64) })
})

test("B2a: invalid or empty export bytes surface as a real failure", async () => {
  const html = client(async () => new Response("not docx", { headers: { "Content-Type": "text/html" } }))
  await assert.rejects(html.downloadExport("result-1", "export-1"), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "UNAVAILABLE")
  const empty = client(async () => new Response(new Uint8Array(), { headers: { "Content-Type": DOCX_TYPE } }))
  await assert.rejects(empty.downloadExport("result-1", "export-1"), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "UNAVAILABLE")
})

test("B2a: malformed response bodies are reported without leaking them", async () => {
  const instance = client(async () => new Response("private-project-payload", { status: 200, headers: { "Content-Type": "application/json" } }))
  await assert.rejects(instance.listTasks(), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "FAILED" && !failure.message.includes("private-project-payload"))
  const shape = client(async () => Response.json({ tasks: "not-an-array" }))
  await assert.rejects(shape.listTasks(), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "FAILED")
  const results = client(async () => Response.json([{ kind: "contract-review" }]))
  await assert.rejects(results.listResults(), (failure: unknown) =>
    failure instanceof ProjectReviewError && failure.code === "FAILED")
})

test("B2a: project reads use the existing material/task/result paths", async () => {
  const requests: string[] = []
  const materialSummary = {
    id: "material-1", title: "专业分包合同", format: "docx", versionId: "version-1", sha256: "a".repeat(64),
    parseTaskId: "parse-task-1", parseState: "success", snapshotId: "snapshot-1",
    coverage: { status: "available", textLength: 493, pageCount: 3, findings: [] },
  }
  const instance = client(async input => {
    const path = String(input)
    requests.push(path)
    if (path.endsWith("/materials")) return Response.json({ materials: [materialSummary] })
    if (path.includes("?projectId=")) return Response.json({ tasks: [task] })
    if (path === "/api/tasks/task-1") return Response.json(task)
    return Response.json(result)
  })
  assert.equal((await instance.listMaterials())[0].sha256, "a".repeat(64))
  assert.equal((await instance.listTasks())[0].id, "task-1")
  assert.equal((await instance.getTask("task-1")).state, "queued")
  assert.equal((await instance.getResult("result-1", "version-1")).resultId, "result-1")
  assert.deepEqual(requests, [
    "/api/projects/project-1/materials",
    "/api/tasks?projectId=project-1",
    "/api/tasks/task-1",
    "/api/projects/project-1/results/result-1?versionId=version-1",
  ])
})

test("B2a: admin budget reads and registration use the frozen contract", async () => {
  const requests: { path: string; method: string; body: unknown }[] = []
  const budget = { projectId: "project-1", costLimitFen: 300000, costReservedFen: 0, costChargedFen: 0, remainingFen: 300000, registeredBy: "account-1", registeredAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z", revision: 1 }
  const unregistered = client(async () => Response.json({ budget: null }))
  assert.equal(await unregistered.getBudget(), null)
  const instance = client(async (input, init) => {
    requests.push({ path: String(input), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (init?.method === "POST") return Response.json({ budget })
    return Response.json({ budget })
  })
  assert.equal((await instance.getBudget())?.remainingFen, 300000)
  assert.deepEqual(await instance.registerBudget(300000), budget)
  assert.deepEqual(requests.map(item => [item.path, item.method, item.body]), [
    ["/api/projects/project-1/budget", "GET", null],
    ["/api/projects/project-1/budget", "POST", { costLimitFen: 300000 }],
  ])
  const conflict = client(async () => Response.json({ error: { code: "CONFLICT", message: "项目费用预算不得低于已预留和已用金额。" } }, { status: 409 }))
  await assert.rejects(conflict.registerBudget(100), (failure: unknown) => failure instanceof ProjectReviewError &&
    failure.code === "CONFLICT" && failure.message === "项目费用预算不得低于已预留和已用金额。")
})

test("B2a: non-administrators never request the admin-only budget endpoints", async () => {
  let calls = 0
  const instance = client(async () => { calls++; return Response.json({ budget: null }) }, { canManage: () => false })
  await assert.rejects(instance.getBudget(), (failure: unknown) => failure instanceof ProjectReviewError && failure.code === "ACCESS_DENIED")
  await assert.rejects(instance.registerBudget(100), (failure: unknown) => failure instanceof ProjectReviewError && failure.code === "ACCESS_DENIED")
  assert.equal(calls, 0)
})

test("B2a: an invalid budget amount is refused before any request", async () => {
  let calls = 0
  const instance = client(async () => { calls++; return Response.json({ budget: null }) })
  for (const value of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(instance.registerBudget(value), (failure: unknown) => failure instanceof ProjectReviewError && failure.code === "INVALID")
  }
  assert.equal(calls, 0)
})
