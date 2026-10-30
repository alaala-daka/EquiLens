import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { pngImage, createSyntheticOcrAdapter } from "./ocr-test-fixtures"
import { createUnavailableOcrAdapter } from "./ocr"
import { buildTaskManifest, parseTaskRequest, type TaskManifest } from "../tasks/catalog"
import type { ClaimedTask } from "../tasks/repository"
import type { BudgetUsage } from "../tasks/budget"
import type { TaskExecutor } from "../tasks/runner-core"
import { createCertificateOcrExecutor, certificateOcrAdmission, certificateSubjectKey, type CertificateOcrExecutorDependencies } from "./ocr-executor"
import type { FieldWrite, FinishedOcrRun, NewOcrRun, OcrRunRecord } from "./ocr-repository"
import { BusinessError } from "../projects/errors"

/**
 * C4-OCR `certificate-ocr` executor tests.
 *
 * The adapter is the synthetic test fixture and all persistence is an in-memory
 * recorder, so no external OCR request and no database write is made. The tests
 * cover: truthful success/partial/failed runs, at most two paid calls with
 * reservation before the request, zero calls on budget/revocation/retention/
 * digest/cross-project failures, and no demo fields on any failure.
 */
const projectId = "11111111-1111-4111-8111-111111111111"
const materialId = "22222222-2222-4222-8222-222222222222"
const versionId = "33333333-3333-4333-8333-333333333333"
const owner = "44444444-4444-4444-8444-444444444444"
const certifiedKinds = ["营业执照"]
const imageBytes = pngImage(1024, 768)
const imageSha = createHash("sha256").update(imageBytes).digest("hex")
const startedAt = "2026-10-29T00:00:00.000Z"

type Context = Parameters<TaskExecutor>[1] & { reserved: number[]; settled: { call: number; usage?: BudgetUsage }[] }

function context(overrides: Partial<Pick<Context, "refreshAccess" | "reserveCall" | "settleCall" | "signal">> = {}): Context {
  const reserved: number[] = []
  const settled: { call: number; usage?: BudgetUsage }[] = []
  return {
    signal: new AbortController().signal,
    heartbeat: async () => {},
    refreshAccess: async () => {},
    reserveCall: async call => { reserved.push(call) },
    settleCall: async (call, usage) => { settled.push({ call, usage }) },
    reserved,
    settled,
    ...overrides,
  }
}

function rawJob(manifest: TaskManifest): ClaimedTask {
  return {
    id: "task-1", owner, projectId, kind: "certificate-ocr", token: "token-1", attempt: 1,
    callsUsed: 0, maxCalls: 2, elapsedMs: 0, startedAt, manifest,
  }
}

function job(overrides: { callsUsed?: number; refs?: unknown; conditions?: unknown; maxCalls?: number } = {}): ClaimedTask {
  const request = parseTaskRequest({
    kind: "certificate-ocr",
    projectId,
    refs: overrides.refs ?? { materials: [{ materialVersionId: versionId, sha256: imageSha }] },
    conditions: overrides.conditions ?? { certificateKind: "营业执照", externalProcessingConsent: true },
  })
  const manifest: TaskManifest = buildTaskManifest(request, owner, startedAt)
  return {
    id: "task-1", owner, projectId, kind: "certificate-ocr", token: "token-1", attempt: 1,
    callsUsed: overrides.callsUsed ?? 0, maxCalls: overrides.maxCalls ?? 2, elapsedMs: 0, startedAt, manifest,
  }
}

function versionRecord() {
  return {
    id: versionId, projectId, materialId, revision: 1, sha256: imageSha, size: imageBytes.length,
    contentType: "image/png", objectKey: `projects/${projectId}/materials/${materialId}/versions/${versionId}/${imageSha}`,
    fileName: "certificate.png", createdAt: startedAt,
  }
}

function materialRecord(format: "image" | "docx" = "image", retentionUntil = "2099-01-01") {
  return {
    id: materialId, projectId, title: "营业执照", fileName: "certificate.png", format, sourceKind: "synthetic" as const,
    sourceReference: "合成证照", processingAuthorized: true, purpose: "材料核验", retentionUntil, status: "active" as const,
    latestRevision: 0, latestVersionId: versionId, createdBy: owner, createdAt: startedAt,
  }
}

function recorder() {
  const runs: NewOcrRun[] = []
  const finished: FinishedOcrRun[] = []
  const fields: FieldWrite[][] = []
  const record: OcrRunRecord = {
    id: "run-1", projectId, materialId, versionId, certificateKind: "营业执照", state: "running",
    provider: null, providerVersion: null, requestId: null, callsUsed: 0, usageJson: null, imageJson: null,
    errorCode: null, createdBy: owner, startedAt, finishedAt: null,
  }
  return {
    runs, finished, fields,
    beginRun: async (input: NewOcrRun) => { runs.push(input); return record },
    finishRun: async (input: FinishedOcrRun) => { finished.push(input) },
    completeRun: async (input: FinishedOcrRun & { fields?: readonly FieldWrite[] }) => {
      if (input.fields?.length) fields.push([...input.fields])
      finished.push(input)
      return []
    },
  }
}

function deps(overrides: Partial<CertificateOcrExecutorDependencies> & { adapter?: CertificateOcrExecutorDependencies["adapter"] } = {}) {
  const ocr = recorder()
  const repository = {
    versionById: async (project: string, version: string) => project === projectId && version === versionId ? versionRecord() as never : null,
    findMaterial: async (project: string, material: string) => project === projectId && material === materialId ? materialRecord() as never : null,
  }
  const store = {
    get: async (key: string) => key === versionRecord().objectKey
      ? { key, sha256: imageSha, size: imageBytes.length, bytes: new Uint8Array(imageBytes), contentType: "image/png" }
      : null,
  }
  const dependencies: CertificateOcrExecutorDependencies = {
    adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds }),
    repository,
    ocr,
    store,
    readProjectRetention: async () => "2099-01-01",
    now: () => new Date(startedAt),
    ...overrides,
  }
  return { dependencies, ocr, repository, store }
}

test("C4-OCR executor: success runs exactly one call and writes OCR fields through the run", async () => {
  const { dependencies, ocr } = deps()
  const ctx = context()
  const result = await createCertificateOcrExecutor(dependencies)(job(), ctx)
  assert.deepEqual(result, { outcome: "success", resultSummary: JSON.stringify({ runId: "run-1", state: "succeeded", fields: 7, subjectKey: "enterprise" }) })
  assert.deepEqual(ctx.reserved, [1])
  assert.equal(ctx.settled.length, 1)
  assert.equal(ctx.settled[0].call, 1)
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 1)
  assert.equal(ocr.runs.length, 1)
  assert.equal(ocr.finished.length, 1)
  assert.equal(ocr.finished[0].state, "succeeded")
  assert.equal(ocr.finished[0].callsUsed, 1)
  assert.equal(ocr.finished[0].provider, "synthetic-ocr")
  assert.match(String(ocr.finished[0].imageJson), /"width":1024/)
  assert.equal(ocr.fields.length, 1)
  const writes = ocr.fields[0]
  assert.equal(writes.length, 7)
  assert.ok(writes.every(write => write.origin === "ocr" && write.subjectKey === "enterprise" && write.ocrRunId === "run-1"))
  assert.ok(writes.every(write => write.idempotencyKey === `ocr:run-1:enterprise:${write.fieldKey}`))
})

test("C4-OCR executor: missing critical field or low confidence is an honest partial run", async () => {
  const missing = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, fields: [{ fieldKey: "subject_name", valueText: "合成测试建设有限公司", confidence: 90 }] }) })
  const partial = await createCertificateOcrExecutor(missing.dependencies)(job(), context())
  assert.equal(partial.outcome, "partial")
  assert.equal(missing.ocr.finished[0].state, "partial")
  assert.equal(missing.ocr.fields[0].length, 1)

  const low = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, fields: [
    { fieldKey: "subject_name", valueText: "合成测试建设有限公司", confidence: 40 },
    { fieldKey: "certificate_number", valueText: "D131000000", confidence: 92 },
  ] }) })
  const lowConfidence = await createCertificateOcrExecutor(low.dependencies)(job(), context())
  assert.equal(lowConfidence.outcome, "partial")
  assert.equal(low.ocr.finished[0].state, "partial")
  // Confidence is passed through to the field write unchanged (never dropped).
  const lowWrites = low.ocr.fields[0]
  assert.equal(lowWrites.find(write => write.fieldKey === "subject_name")?.confidence, 40)
  assert.equal(lowWrites.find(write => write.fieldKey === "certificate_number")?.confidence, 92)
  const missingWrites = missing.ocr.fields[0]
  assert.equal(missingWrites[0].confidence, 90)
})

test("C4-OCR executor: unavailable adapter fails truthfully with zero external calls and no fields", async () => {
  const { dependencies, ocr } = deps({ adapter: createUnavailableOcrAdapter() })
  const result = await createCertificateOcrExecutor(dependencies)(job(), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_UNAVAILABLE")
  assert.equal(ocr.runs.length, 1)
  assert.equal(ocr.finished[0].state, "unavailable")
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: unmeasured/unknown certificate kind never reaches the provider", async () => {
  const { dependencies, ocr } = deps({ adapter: createSyntheticOcrAdapter({ kinds: ["营业执照"] }) })
  for (const certificateKind of ["人员资格证书", "unknown_certificate_v9"]) {
    const result = await createCertificateOcrExecutor(dependencies)(
      job({ conditions: { certificateKind, externalProcessingConsent: true } }),
      context(),
    )
    assert.equal(result.outcome, "failed")
    assert.equal(result.errorCode, "OCR_KIND_NOT_SUPPORTED")
  }
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
  assert.equal(ocr.runs.length, 0)
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: identifier and Chinese certificate kinds map to the same field subject group", async () => {
  assert.equal(certificateSubjectKey("营业执照"), "enterprise")
  assert.equal(certificateSubjectKey("enterprise_license"), "enterprise")
  assert.equal(certificateSubjectKey("建筑业企业资质证书"), "enterprise")
  assert.equal(certificateSubjectKey("人员资格证书"), "person")
  assert.equal(certificateSubjectKey("person_certificate"), "person")
  // A kind without an explicit mapping must never be guessed into a subject group.
  assert.equal(certificateSubjectKey("unknown_person_kind"), null)
  // An identifier-spelled kind allowed by the adapter writes enterprise subject fields.
  const { dependencies, ocr } = deps({ adapter: createSyntheticOcrAdapter({ kinds: ["enterprise_license"] }) })
  const result = await createCertificateOcrExecutor(dependencies)(
    job({ conditions: { certificateKind: "enterprise_license", externalProcessingConsent: true } }),
    context(),
  )
  assert.equal(result.outcome, "success")
  assert.ok(ocr.fields[0].length > 0)
  assert.ok(ocr.fields[0].every(write => write.subjectKey === "enterprise"))
})

test("C4-OCR executor: an allowlisted but unmapped certificate kind fails closed with zero provider calls", async () => {
  const adapter = createSyntheticOcrAdapter({ kinds: ["unknown_person_kind"] })
  // Admission only checks exact allowlist membership, so it accepts this kind ...
  await certificateOcrAdmission(adapter)({
    kind: "certificate-ocr", projectId,
    refs: { materials: [{ materialVersionId: versionId, sha256: imageSha }] },
    conditions: { certificateKind: "unknown_person_kind", externalProcessingConsent: true },
  })
  // ... and the executor still refuses it before any material/provider work because
  // the subject group is not explicitly mapped (no enterprise/person guess).
  const { dependencies, ocr } = deps({ adapter })
  const result = await createCertificateOcrExecutor(dependencies)(
    job({ conditions: { certificateKind: "unknown_person_kind", externalProcessingConsent: true } }),
    context(),
  )
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_KIND_NOT_SUPPORTED")
  assert.equal(adapter.calls, 0)
  assert.equal(ocr.runs.length, 0)
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: manifest digest mismatch, wrong format and cross-project version make zero calls", async () => {
  const tampered = deps()
  const mismatched = await createCertificateOcrExecutor(tampered.dependencies)(
    job({ refs: { materials: [{ materialVersionId: versionId, sha256: "b".repeat(64) }] } }), context(),
  )
  assert.equal(mismatched.errorCode, "INVALID_SOURCE")
  assert.equal(tampered.ocr.runs.length, 0)

  const wrongFormat = deps({ repository: { versionById: async () => versionRecord() as never, findMaterial: async () => materialRecord("docx") as never } })
  const rejected = await createCertificateOcrExecutor(wrongFormat.dependencies)(job(), context())
  assert.equal(rejected.errorCode, "INVALID_SOURCE")
  assert.equal(wrongFormat.ocr.fields.length, 0)

  const crossProject = deps({ repository: { versionById: async () => null, findMaterial: async () => null } })
  const unknown = await createCertificateOcrExecutor(crossProject.dependencies)(job(), context())
  assert.equal(unknown.errorCode, "INVALID_SOURCE")
  assert.equal(crossProject.ocr.runs.length, 0)
})

test("C4-OCR executor: expired project or material retention blocks the call", async () => {
  const projectExpired = deps({ readProjectRetention: async () => "2020-01-01" })
  const result = await createCertificateOcrExecutor(projectExpired.dependencies)(job(), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "RETENTION_EXPIRED")
  assert.equal(projectExpired.ocr.finished[0].errorCode, "RETENTION_EXPIRED")
  assert.equal(projectExpired.ocr.fields.length, 0)

  const materialExpired = deps({ repository: { versionById: async () => versionRecord() as never, findMaterial: async () => materialRecord("image", "2020-01-01") as never } })
  const materialResult = await createCertificateOcrExecutor(materialExpired.dependencies)(job(), context())
  assert.equal(materialResult.errorCode, "RETENTION_EXPIRED")
  assert.equal((materialExpired.dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
})

test("C4-OCR executor: fields are not written when retention expires or access is revoked after the provider call", async () => {
  // Retention expires between the OCR call and the field INSERT.
  let retentionReads = 0
  const retentionDeps = deps({ readProjectRetention: async () => { retentionReads += 1; return retentionReads >= 3 ? "2020-01-01" : "2099-01-01" } })
  const expired = await createCertificateOcrExecutor(retentionDeps.dependencies)(job(), context())
  assert.equal(expired.outcome, "failed")
  assert.equal(expired.errorCode, "RETENTION_EXPIRED")
  assert.equal((retentionDeps.dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 1)
  assert.equal(retentionDeps.ocr.fields.length, 0)
  assert.equal(retentionDeps.ocr.finished[0].errorCode, "RETENTION_EXPIRED")

  // Access is revoked between the OCR call and the field INSERT: no field row, truthful ACCESS_REVOKED.
  let refreshes = 0
  const revokedDeps = deps()
  const revoked = Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })
  const ctx = context({ refreshAccess: async () => { refreshes += 1; if (refreshes >= 4) throw revoked } })
  await assert.rejects(createCertificateOcrExecutor(revokedDeps.dependencies)(job(), ctx), (failure: unknown) =>
    (failure as { code?: string }).code === "ACCESS_REVOKED")
  assert.equal((revokedDeps.dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 1)
  assert.equal(revokedDeps.ocr.fields.length, 0)
  assert.equal(revokedDeps.ocr.finished[0].errorCode, "ACCESS_REVOKED")
})

test("C4-OCR executor: budget reservation failure means zero external calls", async () => {
  const { dependencies, ocr } = deps()
  const ctx = context({ reserveCall: async () => { throw new BusinessError("BUDGET_EXHAUSTED", "项目预算不足。") } })
  const result = await createCertificateOcrExecutor(dependencies)(job(), ctx)
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_BUDGET_EXHAUSTED")
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
  assert.equal(ocr.finished[0].errorCode, "OCR_BUDGET_EXHAUSTED")
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: a recovered attempt that already used two calls rejects a third", async () => {
  const { dependencies, ocr } = deps()
  const result = await createCertificateOcrExecutor(dependencies)(job({ callsUsed: 2 }), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_BUDGET_EXHAUSTED")
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
  assert.equal(ocr.finished[0].callsUsed, 2)
})

test("C4-OCR executor: retries stop after two provider requests and never fake fields", async () => {
  const failing = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, failures: 2 }) })
  const result = await createCertificateOcrExecutor(failing.dependencies)(job(), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_FAILED")
  assert.equal((failing.dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 2)
  assert.equal(failing.ocr.fields.length, 0)

  const empty = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, fields: [], text: null }) })
  const noText = await createCertificateOcrExecutor(empty.dependencies)(job(), context())
  assert.equal(noText.outcome, "failed")
  assert.equal(noText.errorCode, "OCR_NO_TEXT")
  assert.equal((empty.dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 2)
  assert.equal(empty.ocr.fields.length, 0)
})

test("C4-OCR executor: revoked access stops the run before the provider call", async () => {
  const { dependencies, ocr } = deps()
  const revoked = Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })
  await assert.rejects(
    createCertificateOcrExecutor(dependencies)(job(), context({ refreshAccess: async () => { throw revoked } })),
    (failure: unknown) => (failure as { code?: string }).code === "ACCESS_REVOKED",
  )
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
  assert.equal(ocr.runs.length, 0)
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: lease/attempt loss between attempts stops further external calls", async () => {
  const { dependencies, ocr } = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, failures: 1 }) })
  const revoked = Object.assign(new Error("任务执行权限已撤销。"), { code: "ACCESS_REVOKED" })
  let refreshes = 0
  const ctx = context({ refreshAccess: async () => { refreshes += 1; if (refreshes >= 4) throw revoked } })
  await assert.rejects(createCertificateOcrExecutor(dependencies)(job(), ctx), (failure: unknown) => (failure as { code?: string }).code === "ACCESS_REVOKED")
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 1)
  assert.equal(ocr.finished[0].state, "failed")
  assert.equal(ocr.finished[0].errorCode, "ACCESS_REVOKED")
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: tampered stored object is rejected before the call", async () => {
  const { dependencies } = deps({
    store: { get: async (key: string) => ({ key, sha256: imageSha, size: imageBytes.length, bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }) },
  })
  const result = await createCertificateOcrExecutor(dependencies)(job(), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "INVALID_SOURCE")
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
})

test("C4-OCR executor: malformed manifest is rejected without any run or call", async () => {
  const { dependencies, ocr } = deps()
  const malformed = rawJob({
    version: 1, catalogVersion: 3, kind: "certificate-ocr", projectId, submittedBy: owner, submittedAt: startedAt,
    refs: { materials: [
      { materialVersionId: versionId, sha256: imageSha },
      { materialVersionId: "55555555-5555-4555-8555-555555555555", sha256: imageSha },
    ] },
    conditions: { certificateKind: "营业执照", externalProcessingConsent: true },
  })
  const twoMaterials = await createCertificateOcrExecutor(dependencies)(malformed, context())
  assert.equal(twoMaterials.outcome, "failed")
  assert.equal(twoMaterials.errorCode, "INVALID_SUBMISSION")
  assert.equal(ocr.runs.length, 0)
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
})

test("C4-OCR executor: a hanging provider request times out truthfully after at most two requests", async () => {
  const { dependencies, ocr } = deps({ adapter: createSyntheticOcrAdapter({ kinds: certifiedKinds, delayMs: 200 }), requestTimeoutMs: 10 })
  const result = await createCertificateOcrExecutor(dependencies)(job(), context())
  assert.equal(result.outcome, "failed")
  assert.equal(result.errorCode, "OCR_TIMEOUT")
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 2)
  assert.equal(ocr.finished[0].errorCode, "OCR_TIMEOUT")
  assert.equal(ocr.fields.length, 0)
})

test("C4-OCR executor: aborted task signal stops before the provider request", async () => {
  const { dependencies, ocr } = deps()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(createCertificateOcrExecutor(dependencies)(job(), context({ signal: controller.signal })))
  assert.equal((dependencies.adapter as ReturnType<typeof createSyntheticOcrAdapter>).calls, 0)
  assert.equal(ocr.fields.length, 0)
})
