import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProjectAccess } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { BusinessError } from "../projects/errors"
import { OcrRepository, VerificationFieldService, type FieldWrite } from "./ocr-repository"

/**
 * C4-OCR repository tests (real SQLite, migration 0010):
 *  - OCR runs are insert-once and transition running -> terminal exactly once;
 *  - verification fields are insert-only history with at most one current value
 *    per (material version, subject, field), correction via previous_id/revision
 *    and superseded_at, and FieldSource only exposes current values;
 *  - the manual field path counts a value as material-supported only when a
 *    same-version fragment contains it verbatim, otherwise it stays pending.
 */

const projectId = "11111111-1111-4111-8111-111111111111"
const otherProject = "99999999-9999-4999-8999-999999999999"
const materialId = "22222222-2222-4222-8222-222222222222"
const versionId = "33333333-3333-4333-8333-333333333333"
const otherVersion = "44444444-4444-4444-8444-444444444444"
const snapshotId = "55555555-5555-4555-8555-555555555555"
const fragmentId = "66666666-6666-4666-8666-666666666666"

const alice: AuthIdentity = { account: { id: "alice", username: "alice", role: "member" }, session: { id: "s1", expiresAt: 0 } }
const viewer: AuthIdentity = { account: { id: "viewer", username: "viewer", role: "member" }, session: { id: "s2", expiresAt: 0 } }

function write(overrides: Partial<FieldWrite> & Pick<FieldWrite, "subjectKey" | "fieldKey" | "valueText" | "idempotencyKey">): FieldWrite {
  return {
    projectId, materialId, versionId, origin: "ocr", createdBy: "alice",
    sourceSnapshotId: null, sourceFragmentId: null, ocrRunId: null, confidence: null, boxJson: null, reason: null,
    ...overrides,
  }
}

async function setup() {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  let tick = 0
  const repository = new OcrRepository(database, () => new Date(Date.parse("2026-10-29T00:00:00Z") + tick++ * 1000))
  return { database, repository }
}

test("C4-OCR repository: insert-only field history and FieldSource current values", async () => {
  const { database, repository } = await setup()
  try {
    const [first] = await repository.insertFields([
      write({ subjectKey: "enterprise", fieldKey: "subject_name", valueText: "  合成测试建设有限公司  ", idempotencyKey: "op-1" }),
      write({ subjectKey: "enterprise", fieldKey: "unified_social_credit_code", valueText: "9131 0000 ma1k000000", idempotencyKey: "op-1" }),
      write({ subjectKey: "enterprise", fieldKey: "expiry_date", valueText: "2027年1月1日", idempotencyKey: "op-1" }),
    ])
    assert.equal(first.revision, 1)
    assert.equal(first.origin, "ocr")
    assert.equal(first.previousId, null)
    // Normalization comes from the frozen shared vocabulary.
    const current = await repository.values(projectId, [versionId])
    assert.deepEqual(current.map(value => [value.fieldKey, value.valueText, value.normalizedValue]), [
      ["expiry_date", "2027年1月1日", "2027-01-01"],
      ["subject_name", "  合成测试建设有限公司  ", "合成测试建设有限公司"],
      ["unified_social_credit_code", "9131 0000 ma1k000000", "91310000MA1K000000"],
    ])

    const corrected = await repository.insertFields([
      write({ subjectKey: "enterprise", fieldKey: "subject_name", valueText: "合成测试建设有限公司（更正）", idempotencyKey: "op-2", reason: "人工更正" }),
    ])
    assert.equal(corrected[0].revision, 2)
    assert.equal(corrected[0].previousId, first.id)
    assert.equal(corrected[0].reason, "人工更正")
    const after = await repository.values(projectId, [versionId])
    assert.deepEqual(after.filter(value => value.fieldKey === "subject_name").map(value => value.revision), [2])
    const history = await repository.fieldHistory(projectId, versionId)
    assert.equal(history.length, 4)
    assert.equal(history.filter(record => record.supersededAt === null).length, 3)
    const superseded = history.find(record => record.id === first.id)
    assert.ok(superseded?.supersededAt)
    // Only the requested project and version are exposed.
    assert.deepEqual(await repository.values(otherProject, [versionId]), [])
    assert.deepEqual(await repository.values(projectId, [otherVersion]), [])
    assert.deepEqual(await repository.values(projectId, []), [])
  } finally { await database.close() }
})

test("C4-OCR repository: retried write is idempotent (same operation inserts no second row)", async () => {
  const { database, repository } = await setup()
  try {
    const input = write({ subjectKey: "enterprise", fieldKey: "certificate_number", valueText: "D131000000", idempotencyKey: "op-retry" })
    const [first] = await repository.insertFields([input])
    const [retried] = await repository.insertFields([input])
    assert.equal(retried.id, first.id)
    assert.equal((await repository.fieldHistory(projectId, versionId)).length, 1)
    assert.equal((await repository.values(projectId, [versionId])).length, 1)
  } finally { await database.close() }
})

test("C4-OCR repository: concurrent writers still leave exactly one current value", async () => {
  const { database, repository } = await setup()
  try {
    await Promise.all([
      repository.insertFields([write({ subjectKey: "enterprise", fieldKey: "certificate_level", valueText: "一级", idempotencyKey: "write-a" })]),
      repository.insertFields([write({ subjectKey: "enterprise", fieldKey: "certificate_level", valueText: "二级", idempotencyKey: "write-b" })]),
    ])
    const current = await repository.currentFields(projectId, versionId)
    assert.equal(current.length, 1)
    const history = await repository.fieldHistory(projectId, versionId)
    assert.equal(history.length, 2)
    assert.equal(history.filter(record => record.supersededAt === null).length, 1)
    assert.equal(history[0].revision, 2)
    assert.equal(history[0].previousId, history[1].id)
  } finally { await database.close() }
})

test("C4-OCR repository: multiple certificate subjects coexist per material version", async () => {
  const { database, repository } = await setup()
  try {
    await repository.insertFields([
      write({ subjectKey: "enterprise", fieldKey: "subject_name", valueText: "合成测试建设有限公司", idempotencyKey: "multi-1" }),
      write({ subjectKey: "person:holder-1", fieldKey: "holder_name", valueText: "张三", idempotencyKey: "multi-1" }),
    ])
    const current = await repository.values(projectId, [versionId])
    assert.deepEqual(current.map(value => value.subjectKey), ["enterprise", "person:holder-1"])
    assert.deepEqual(current.map(value => value.fieldKey), ["subject_name", "holder_name"])
  } finally { await database.close() }
})

test("C4-OCR repository: OCR runs transition running -> terminal exactly once", async () => {
  const { database, repository } = await setup()
  try {
    const run = await repository.beginRun({ projectId, materialId, versionId, certificateKind: "营业执照", createdBy: "alice" })
    assert.equal(run.state, "running")
    assert.equal(run.callsUsed, 0)
    await repository.finishRun({
      projectId, id: run.id, state: "succeeded", callsUsed: 1,
      provider: "synthetic-ocr", providerVersion: "synthetic-1", requestId: "req-1",
      usageJson: JSON.stringify({ calls: 1 }), imageJson: JSON.stringify({ format: "png", width: 100, height: 100 }), errorCode: null,
    })
    const finished = await repository.findRun(projectId, run.id)
    assert.equal(finished?.state, "succeeded")
    assert.equal(finished?.callsUsed, 1)
    assert.equal(finished?.provider, "synthetic-ocr")
    assert.ok(finished?.finishedAt)
    assert.equal((await repository.runs(projectId, materialId)).length, 1)
    await assert.rejects(repository.finishRun({ projectId, id: run.id, state: "failed", callsUsed: 2 }), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "CONFLICT")
    assert.equal((await repository.findRun(otherProject, run.id)), null)
  } finally { await database.close() }
})

test("C4-OCR repository: completeRun writes fields and terminal state atomically", async () => {
  const { database, repository } = await setup()
  try {
    const run = await repository.beginRun({ projectId, materialId, versionId, certificateKind: "营业执照", createdBy: "alice" })
    await repository.completeRun({
      projectId, id: run.id, state: "succeeded", callsUsed: 1, errorCode: null,
      fields: [write({ subjectKey: "enterprise", fieldKey: "certificate_number", valueText: "D131000000", idempotencyKey: "complete-1", ocrRunId: run.id })],
    })
    assert.equal((await repository.findRun(projectId, run.id))?.state, "succeeded")
    assert.equal((await repository.values(projectId, [versionId])).length, 1)
    // A second terminal transition rolls the whole transaction back: no new field
    // row appears and the finished run stays unchanged.
    await assert.rejects(repository.completeRun({
      projectId, id: run.id, state: "failed", callsUsed: 2,
      fields: [write({ subjectKey: "enterprise", fieldKey: "certificate_number", valueText: "D131999999", idempotencyKey: "complete-2", ocrRunId: run.id })],
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "CONFLICT")
    const current = await repository.values(projectId, [versionId])
    assert.deepEqual(current.map(value => value.valueText), ["D131000000"])
    assert.equal((await repository.findRun(projectId, run.id))?.state, "succeeded")
  } finally { await database.close() }
})

type ManualServiceOptions = {
  materialStatus?: "active" | "deleted"
  processingAuthorized?: boolean
  materialRetention?: string
  projectRetention?: string | null
  /** Throw FORBIDDEN once more than this many access checks have run (revocation mid-write). */
  accessFailureAfter?: number
}

function manualService(repository: OcrRepository, options: ManualServiceOptions = {}) {
  let accessChecks = 0
  const material = () => ({
    id: materialId, projectId, format: "docx", status: options.materialStatus ?? "active",
    processingAuthorized: options.processingAuthorized ?? true, retentionUntil: options.materialRetention ?? "2099-01-01",
  })
  const materials = {
    findMaterial: async (project: string, materialIdValue: string) =>
      project === projectId && materialIdValue === materialId ? material() as never : null,
    findVersion: async (project: string, material: string, version: string) =>
      project === projectId && material === materialId && version === versionId ? ({ id: versionId, projectId, materialId, sha256: "a".repeat(64) } as never) : null,
    findFragmentForVersion: async (project: string, version: string, fragment: string) =>
      project === projectId && version === versionId && fragment === fragmentId
        ? ({ id: fragmentId, snapshotId, projectId, text: "统一社会信用代码：91310000MA1K000000。" } as never)
        : null,
  }
  const requireProjectAccess = async (identity: AuthIdentity, project: string, action: "read" | "edit" | "manage"): Promise<ProjectAccess> => {
    accessChecks += 1
    if (options.accessFailureAfter !== undefined && accessChecks > options.accessFailureAfter) throw new BusinessError("FORBIDDEN", "无权访问该项目。")
    if (action !== "read" && identity.account.id === "viewer") throw new BusinessError("FORBIDDEN", "无权访问该项目。")
    if (project !== projectId) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    return { projectId: project, action, role: identity.account.id === "viewer" ? "viewer" : "admin", identity }
  }
  return new VerificationFieldService({
    repository, materials, requireProjectAccess,
    readProjectRetention: async () => options.projectRetention === undefined ? "2099-01-01" : options.projectRetention,
    now: () => new Date("2026-10-29T00:00:00Z"),
  })
}

test("C4-OCR fields: manual value is only material-supported with a same-version verbatim fragment", async () => {
  const { database, repository } = await setup()
  try {
    const service = manualService(repository)
    const ref = { projectId, materialId, versionId }

    const supported = await service.register(alice, ref, {
      operationId: "fields-op-1",
      fields: [{ fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", sourceFragmentId: fragmentId }],
    })
    assert.equal(supported.fields.length, 1)
    assert.equal(supported.fields[0].support, "material_text")
    assert.equal(supported.fields[0].origin, "material_text")
    assert.equal(supported.fields[0].sourceFragmentId, fragmentId)
    assert.equal(supported.fields[0].sourceSnapshotId, snapshotId)
    assert.equal(supported.fields[0].normalizedValue, "91310000MA1K000000")

    const pending = await service.register(alice, ref, {
      operationId: "fields-op-2",
      fields: [{ fieldKey: "certificate_level", valueText: "一级" }],
    })
    assert.equal(pending.fields[0].support, "pending")
    assert.equal(pending.fields[0].origin, "manual")
    assert.equal(pending.fields[0].sourceFragmentId, null)

    // A value that does not appear verbatim in the cited fragment is rejected.
    await assert.rejects(service.register(alice, ref, {
      operationId: "fields-op-3",
      fields: [{ fieldKey: "unified_social_credit_code", valueText: "91310000MA1K999999", sourceFragmentId: fragmentId }],
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    // A fragment of another material version is indistinguishable from missing.
    await assert.rejects(service.register(alice, ref, {
      operationId: "fields-op-4",
      fields: [{ fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", sourceFragmentId: "77777777-7777-4777-8777-777777777777" }],
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    // Dates must normalize (spec 01 §4.2 shared vocabulary).
    await assert.rejects(service.register(alice, ref, {
      operationId: "fields-op-5",
      fields: [{ fieldKey: "expiry_date", valueText: "长期有效" }],
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
  } finally { await database.close() }
})

test("C4-OCR fields: corrections are insert-only history, idempotent and role-guarded", async () => {
  const { database, repository } = await setup()
  try {
    const service = manualService(repository)
    const ref = { projectId, materialId, versionId }
    const first = await service.register(alice, ref, {
      operationId: "correct-op-1", reason: "首次登记",
      fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }],
    })
    assert.equal(first.fields[0].revision, 1)
    const retried = await service.register(alice, ref, {
      operationId: "correct-op-1", reason: "首次登记",
      fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }],
    })
    assert.equal(retried.fields[0].id, first.fields[0].id)
    assert.equal(retried.fields[0].revision, 1)

    const corrected = await service.register(alice, ref, {
      operationId: "correct-op-2", reason: "更正证书编号",
      fields: [{ fieldKey: "certificate_number", valueText: "D131999999", subjectKey: "enterprise" }],
    })
    assert.equal(corrected.fields[0].revision, 2)
    assert.equal(corrected.fields[0].previousId, first.fields[0].id)
    const listed = await service.list(alice, ref)
    assert.equal(listed.fields.length, 1)
    assert.equal(listed.history.length, 1)
    assert.equal(listed.history[0].valueText, "D131000000")
    assert.equal(listed.history[0].reason, "首次登记")

    await assert.rejects(service.register(viewer, ref, {
      operationId: "correct-op-3", fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }],
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "FORBIDDEN")
    assert.equal((await service.list(viewer, ref)).fields.length, 1)
    // Viewer read of another project is a 404, not a leak.
    await assert.rejects(service.list(alice, { projectId: otherProject, materialId, versionId }), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "NOT_FOUND")
  } finally { await database.close() }
})

test("C4-OCR fields: a pre-write recheck blocks expired retention, unauthorized processing and revocation", async () => {
  const { database, repository } = await setup()
  try {
    const ref = { projectId, materialId, versionId }
    const body = { operationId: "recheck-op-1", fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }] }

    const materialExpired = manualService(repository, { materialRetention: "2020-01-01" })
    await assert.rejects(materialExpired.register(alice, ref, body), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "INVALID_SOURCE")
    const projectExpired = manualService(repository, { projectRetention: "2020-01-01" })
    await assert.rejects(projectExpired.register(alice, ref, body), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "INVALID_SOURCE")
    const unauthorized = manualService(repository, { processingAuthorized: false })
    await assert.rejects(unauthorized.register(alice, ref, body), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "INVALID_SOURCE")
    const deleted = manualService(repository, { materialStatus: "deleted" })
    await assert.rejects(deleted.register(alice, ref, body), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "NOT_FOUND")
    // The first access check (target lookup) succeeds, the pre-write recheck fails.
    const revoked = manualService(repository, { accessFailureAfter: 1 })
    await assert.rejects(revoked.register(alice, ref, body), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "FORBIDDEN")
    // No failed check may leave a field-history row behind.
    assert.deepEqual(await repository.fieldHistory(projectId, versionId), [])
  } finally { await database.close() }
})

test("C4-OCR fields: OCR confidence is persisted per field and survives correction history", async () => {
  const { database, repository } = await setup()
  try {
    const [low, unknown] = await repository.insertFields([
      write({ subjectKey: "enterprise", fieldKey: "certificate_number", valueText: "D131000000", idempotencyKey: "confidence-1", confidence: 42 }),
      write({ subjectKey: "enterprise", fieldKey: "subject_name", valueText: "合成测试建设有限公司", idempotencyKey: "confidence-1", confidence: null }),
    ])
    assert.equal(low.confidence, 42)
    assert.equal(unknown.confidence, null)
    const current = await repository.values(projectId, [versionId])
    assert.equal(current.find(value => value.fieldKey === "certificate_number")?.confidence, 42)
    assert.equal(current.find(value => value.fieldKey === "subject_name")?.confidence, null)
    // A later manual correction keeps the recognized original in history with its confidence.
    await repository.insertFields([
      write({ subjectKey: "enterprise", fieldKey: "certificate_number", valueText: "D131999999", idempotencyKey: "confidence-2", origin: "manual", confidence: 90 }),
    ])
    const history = await repository.fieldHistory(projectId, versionId)
    const original = history.find(record => record.id === low.id)
    assert.equal(original?.confidence, 42)
    assert.ok(original?.supersededAt)
    assert.equal(history.find(record => record.supersededAt === null && record.fieldKey === "certificate_number")?.confidence, 90)
  } finally { await database.close() }
})
