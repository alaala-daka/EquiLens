import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { BusinessError } from "../projects/errors"
import { resultHandler } from "../results/http"
import { draftingTemplates, missingFields } from "../templates/catalog"
import { setupDrafting, specialtyFields, supplementaryFields, testAuthorizer, testIdentity, projectId } from "./drafting-test-fixtures"

test("C5 input: save creates one immutable proposed-input version with template pin and no draft yet", async () => {
  const fixture = await setupDrafting()
  try {
    const saved = await fixture.saveInput("specialty-subcontract-v1", specialtyFields())
    assert.equal(saved.input.kind, "specialty-subcontract")
    assert.equal(saved.input.templateId, "specialty-subcontract-v1")
    assert.equal(saved.input.version, 1)
    assert.equal(saved.input.templateStatus, "待核对")
    assert.equal(saved.input.missingCount, 0)
    assert.equal(saved.input.values["pricing.amount"], "1000000.00")
    assert.equal(saved.template.sha256, saved.input.templateSha256)
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
    const listed = await fixture.service.listInputs(testIdentity, testAuthorizer, projectId)
    assert.equal(listed.templates.length, 2)
    assert.equal(listed.inputs.length, 1)
    assert.equal(listed.inputs[0].inputId, saved.input.inputId)
    const detail = await fixture.service.getInput(testIdentity, testAuthorizer, projectId, saved.input.inputId)
    assert.deepEqual(detail.input.values, specialtyFields())
  } finally { await fixture.close() }
})

test("C5 input: operation ids are idempotent, stale bases conflict and versions stay immutable", async () => {
  const fixture = await setupDrafting()
  try {
    const first = await fixture.saveInput("specialty-subcontract-v1", specialtyFields(), { operationId: "op-input-1" })
    const repeat = await fixture.saveInput("specialty-subcontract-v1", specialtyFields(), { operationId: "op-input-1" })
    assert.equal(repeat.input.versionId, first.input.versionId)
    await assert.rejects(fixture.saveInput("specialty-subcontract-v1", specialtyFields({ "project.name": "另一个项目" }), { operationId: "op-input-1" }), { code: "CONFLICT" })
    const second = await fixture.saveInput("specialty-subcontract-v1", specialtyFields({ "project.name": "二期项目" }), { operationId: "op-input-2", inputId: first.input.inputId, baseVersionId: first.input.versionId })
    assert.equal(second.input.version, 2)
    assert.equal(second.input.values["project.name"], "二期项目")
    await assert.rejects(fixture.saveInput("specialty-subcontract-v1", specialtyFields(), { operationId: "op-input-3", inputId: first.input.inputId, baseVersionId: first.input.versionId }), { code: "CONFLICT" })
    const oldVersion = await fixture.repository.version(projectId, first.input.inputId, first.input.versionId)
    assert.ok(oldVersion)
    assert.equal(oldVersion!.payload.fields.find(field => field.fieldId === "project.name")?.value, "测试机电安装项目")
    const history = await fixture.repository.versions(projectId, first.input.inputId)
    assert.deepEqual(history.map(record => record.version), [2, 1])
  } finally { await fixture.close() }
})

test("C5 input: cross-project inputs and field allowlists are rejected", async () => {
  const fixture = await setupDrafting()
  try {
    await fixture.database.transaction(async connection => {
      await connection.query(
        "INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)",
        ["99999999-9999-4999-8999-999999999999", "其他项目", "synthetic", "fixture", "工程验证", "2099-12-31", "active", "22222222-2222-4222-8222-222222222222", "2026-10-29T00:00:00.000Z", "2026-10-29T00:00:00.000Z", 1],
      )
    })
    const other = await fixture.service.saveInput(testIdentity, async (_identity, target, action) => ({ projectId: target, action, role: "editor", identity: testIdentity }), {
      projectId: "99999999-9999-4999-8999-999999999999", templateId: "specialty-subcontract-v1", baseVersionId: "", operationId: "op-other-1", fields: specialtyFields(),
    })
    await assert.rejects(fixture.service.getInput(testIdentity, testAuthorizer, projectId, other.input.inputId), { code: "NOT_FOUND" })
    for (const fields of [
      { ...specialtyFields(), "project.unknown": "x" },
      { ...specialtyFields(), "pricing.amount": "1,000.00" },
      { ...specialtyFields(), "duration.startDate": "2026-02-30" },
      { ...specialtyFields(), "pricing.mode": "not-a-choice" },
      { ...specialtyFields(), "project.name": "长".repeat(201) },
    ]) {
      await assert.rejects(fixture.saveInput("specialty-subcontract-v1", fields), (failure: unknown) =>
        failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    }
    const partial = await fixture.saveInput("specialty-subcontract-v1", {})
    const template = draftingTemplates.find(item => item.id === "specialty-subcontract-v1")!
    assert.equal(partial.input.missingCount, missingFields(template, {}).length)
  } finally { await fixture.close() }
})

test("C5 original contract: supplementary agreement pins an in-project material or specialty result, never a foreign/typed mismatch", async () => {
  const fixture = await setupDrafting()
  try {
    const material = await fixture.addMaterial(["原专业分包合同正文。"], { title: "原专业分包合同" })
    await assert.rejects(fixture.saveInput("supplementary-agreement-v1", supplementaryFields()), (failure: unknown) =>
      failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    const pinned = await fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId },
    })
    assert.equal(pinned.input.originalContract?.kind, "material")
    assert.equal(pinned.input.originalContract?.title, "原专业分包合同")
    assert.equal(pinned.input.originalContract?.versionId, material.versionId)
    await assert.rejects(fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "material", materialId: material.materialId, versionId: "44444444-4444-4444-8444-999999999999" },
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    // A saved specialty-subcontract result is the other allowed original contract source.
    const specialtyDraft = await fixture.saveSpecialtyDraft()
    const fromResult = await fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "result", resultId: specialtyDraft.resultId, versionId: specialtyDraft.versionId },
    })
    assert.equal(fromResult.input.originalContract?.kind, "result")
    // A supplementary-agreement result is not a valid original contract type.
    const supplementary = await fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId },
    })
    const supplementaryDraft = await fixture.generateDraft({ inputId: supplementary.input.inputId })
    await assert.rejects(fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "result", resultId: supplementaryDraft.resultId, versionId: supplementaryDraft.versionId },
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
    // Specialty templates do not accept an original-contract reference at all.
    await assert.rejects(fixture.saveInput("specialty-subcontract-v1", specialtyFields(), {
      originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId },
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
  } finally { await fixture.close() }
})

test("C5 original contract: expired or foreign material versions are rejected before anything is saved", async () => {
  const fixture = await setupDrafting()
  try {
    const expired = await fixture.addMaterial(["过期材料"], { retentionUntil: "2020-01-01" })
    await assert.rejects(fixture.saveInput("supplementary-agreement-v1", supplementaryFields(), {
      originalContract: { kind: "material", materialId: expired.materialId, versionId: expired.versionId },
    }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_SOURCE")
    assert.equal((await fixture.service.listInputs(testIdentity, testAuthorizer, projectId)).inputs.length, 0)
  } finally { await fixture.close() }
})

test("C5 generate: deterministic partial human draft saved through the server-owned result path", async () => {
  const fixture = await setupDrafting()
  try {
    const saved = await fixture.saveInput("specialty-subcontract-v1", specialtyFields())
    const draft = await fixture.generateDraft({ inputId: saved.input.inputId })
    assert.equal(draft.kind, "specialty-subcontract")
    assert.equal(draft.origin, "human")
    assert.equal(draft.validation.status, "partial")
    assert.equal(draft.review, null)
    assert.deepEqual(draft.sources, [])
    assert.deepEqual(draft.dependencies.map(dependency => [dependency.kind, dependency.id, dependency.versionId]), [["template", "specialty-subcontract-v1", "v1"]])
    const value = draft.value as {
      schemaVersion: number; kind: string; status: string; template: { id: string; version: string; sha256: string; status: string };
      input: { inputId: string; versionId: string; version: number; sha256: string };
      fields: Array<{ fieldId: string; value: string; label: string }>; missing: unknown[]; paragraphs: string[];
      warnings: Array<{ code: string }>; renderVersion: string
    }
    assert.equal(value.schemaVersion, 1)
    assert.equal(value.kind, "specialty-subcontract")
    assert.equal(value.status, "partial")
    assert.deepEqual(value.template, { id: "specialty-subcontract-v1", version: "v1", sha256: saved.input.templateSha256, status: "待核对" })
    assert.deepEqual(value.input, { inputId: saved.input.inputId, versionId: saved.input.versionId, version: 1, sha256: saved.input.sha256 })
    assert.equal(value.fields.length, Object.values(specialtyFields()).filter(Boolean).length)
    assert.deepEqual(value.missing, [])
    assert.ok(value.warnings.some(warning => warning.code === "TEMPLATE_UNREVIEWED"))
    assert.equal(value.renderVersion, "drafting-render-v1")
    assert.ok(value.paragraphs.some(paragraph => paragraph.includes("1000000.00")))
    // Identical pinned input re-generates an identical value: the render is deterministic.
    const second = await fixture.generateDraft({ inputId: saved.input.inputId })
    assert.deepEqual(second.value, draft.value)
    assert.notEqual(second.resultId, draft.resultId)
  } finally { await fixture.close() }
})

test("C5 generate: missing fields stay visible with 【待补充】 markers and cannot be approved as complete", async () => {
  const fixture = await setupDrafting()
  try {
    const saved = await fixture.saveInput("specialty-subcontract-v1", {
      "project.name": "测试项目", "parties.employer": "发包人", "pricing.amount": "1000.00",
    })
    const draft = await fixture.generateDraft({ inputId: saved.input.inputId })
    assert.equal(draft.validation.status, "partial")
    const value = draft.value as { missing: Array<{ fieldId: string; label: string; reason: string }>; paragraphs: string[] }
    assert.ok(value.missing.length >= 10)
    assert.ok(value.missing.some(field => field.fieldId === "signature.date" && field.reason === "required"))
    const text = value.paragraphs.join("\n")
    for (const missing of value.missing) assert.ok(text.includes(`【待补充：${missing.label}】`), missing.label)
    assert.equal(draft.review, null)
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
    const rejected = await fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, decision: "changes_requested", comment: "请补齐",
    })
    assert.equal(rejected.review?.decision, "changes_requested")
  } finally { await fixture.close() }
})

test("C5 revise: re-rendering from a new input version creates a new immutable version and resets the whole review", async () => {
  const fixture = await setupDrafting()
  try {
    const first = await fixture.saveInput("specialty-subcontract-v1", specialtyFields())
    const draft = await fixture.generateDraft({ inputId: first.input.inputId })
    await fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, decision: "changes_requested", comment: "补充违约责任",
    })
    const second = await fixture.saveInput("specialty-subcontract-v1", specialtyFields({ "quality.standard": "合格并达到合同约定标准" }), {
      inputId: first.input.inputId, baseVersionId: first.input.versionId,
    })
    const revised = await fixture.service.reviseDraft(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, baseVersionId: draft.versionId,
      inputId: second.input.inputId, versionId: second.input.versionId, sha256: second.input.sha256,
      operationId: "op-revise-1", reason: "按新拟约定输入重渲染",
    })
    assert.equal(revised.resultId, draft.resultId)
    assert.notEqual(revised.versionId, draft.versionId)
    assert.equal(revised.review, null)
    assert.equal((revised.value as { input: { versionId: string } }).input.versionId, second.input.versionId)
    const old = await fixture.results.get(testIdentity, testAuthorizer, projectId, draft.resultId, draft.versionId)
    assert.equal(old.review?.decision, "changes_requested")
    await assert.rejects(fixture.service.reviseDraft(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, baseVersionId: draft.versionId,
      inputId: second.input.inputId, versionId: second.input.versionId, sha256: second.input.sha256,
      operationId: "op-revise-stale", reason: "过期基础版本",
    }), { code: "CONFLICT" })
    await assert.rejects(fixture.service.reviseDraft(testIdentity, testAuthorizer, {
      projectId, resultId: "99999999-9999-4999-8999-999999999999", baseVersionId: draft.versionId,
      inputId: second.input.inputId, versionId: second.input.versionId, sha256: second.input.sha256,
      operationId: "op-revise-missing", reason: "未知成果",
    }), { code: "NOT_FOUND" })
  } finally { await fixture.close() }
})

test("C5 writes: the generic browser results POST can never write a drafting kind", async () => {
  const fixture = await setupDrafting()
  const previousOrigin = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = "https://equilens.invalid"
  try {
    const input = {
      projectId, kind: "specialty-subcontract", baseVersionId: "", operationId: "browser-result-save", reason: "伪造文书",
      value: { paragraphs: ["伪造正文"] }, sources: [], dependencies: [],
    }
    await assert.rejects(fixture.results.saveResultRevision(testIdentity, testAuthorizer, input), { code: "FORBIDDEN" })
    const handler = resultHandler(async () => ({ identity: async () => testIdentity, authorize: testAuthorizer, service: fixture.results }), "save")
    const response = await handler(new NextRequest(`https://equilens.invalid/api/projects/${projectId}/results`, {
      method: "POST",
      headers: { origin: "https://equilens.invalid", "content-type": "application/json" },
      body: JSON.stringify({ kind: "specialty-subcontract", baseVersionId: "", operationId: "browser-result-save", reason: "伪造文书", value: { paragraphs: ["伪造正文"] }, sources: [], dependencies: [] }),
    }), { params: Promise.resolve({ id: projectId }) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, "FORBIDDEN")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = previousOrigin
    await fixture.close()
  }
})
