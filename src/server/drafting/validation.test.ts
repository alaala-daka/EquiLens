import assert from "node:assert/strict"
import { test } from "node:test"
import { unzipSync, strFromU8 } from "fflate"
import { ExportRepository } from "../exports/repository"
import { ExportService, ExportTemplateRegistry } from "../exports/service"
import { setupDrafting, projectId, specialtyFields, testAuthorizer, testIdentity } from "./drafting-test-fixtures"
import { specialtySubcontractExportTemplate, supplementaryAgreementExportTemplate } from "./export-template"
import { inspectDraftingValue, specialtySubcontractValidator, supplementaryAgreementValidator } from "./validation"
import type { DraftingValue } from "./value"

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function draftValue(fixture: Awaited<ReturnType<typeof setupDrafting>>): Promise<DraftingValue> {
  const draft = await fixture.saveSpecialtyDraft()
  return clone(draft.value) as DraftingValue
}

test("C5 validator: a complete deterministic draft is a partial (never valid) result this round", async () => {
  const fixture = await setupDrafting()
  try {
    const value = await draftValue(fixture)
    const checked = await specialtySubcontractValidator(value)
    assert.equal(checked.status, "partial")
    assert.deepEqual(checked.issues, [])
    const supplementaryInput = {
      "parties.employer": "发包人", "parties.contractor": "承包人", "change.kind": "other",
      "change.clause": "第 1 条", "change.content": "调整", "effect.condition": "签署生效", "signature.date": "2026-10-30",
    }
    const material = await fixture.addMaterial(["原合同正文。"], { title: "原专业分包合同" })
    const input = await fixture.saveInput("supplementary-agreement-v1", supplementaryInput, {
      originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId },
    })
    const supplementaryDraft = await fixture.generateDraft({ inputId: input.input.inputId })
    assert.equal(await supplementaryAgreementValidator(supplementaryDraft.value).then(result => result.status), "partial")
    // The cross-kind validator must never accept the other C5 kind.
    assert.equal(await specialtySubcontractValidator(supplementaryDraft.value).then(result => result.status), "invalid")
  } finally { await fixture.close() }
})

test("C5 validator: browser-forged paragraphs, missing lists or statuses are invalid", async () => {
  const fixture = await setupDrafting()
  try {
    const value = await draftValue(fixture)
    const forgedParagraphs = clone(value)
    forgedParagraphs.paragraphs = [...forgedParagraphs.paragraphs]
    forgedParagraphs.paragraphs[2] = "发包人（甲方）：伪造主体有限公司"
    assert.deepEqual((await specialtySubcontractValidator(forgedParagraphs)).issues.map(issue => issue.code), ["INVALID_RENDER"])
    const forgedMissing = clone(value)
    forgedMissing.missing = []
    forgedMissing.fields = forgedMissing.fields.filter(field => field.fieldId !== "project.name")
    assert.equal((await specialtySubcontractValidator(forgedMissing)).status, "invalid")
    const successClaim = clone(value)
    successClaim.status = "success" as unknown as "partial"
    assert.ok((await specialtySubcontractValidator(successClaim)).issues.some(issue => issue.code === "INVALID_STATUS"))
    const forgedField = clone(value)
    forgedField.fields = forgedField.fields.map(field => field.fieldId === "pricing.amount" ? { ...field, value: "1,000.00" } : field)
    assert.equal((await specialtySubcontractValidator(forgedField)).status, "invalid")
    const detachedTemplate = clone(value)
    detachedTemplate.template = { ...detachedTemplate.template, status: "已发布" as unknown as "待核对" }
    assert.ok((await specialtySubcontractValidator(detachedTemplate)).issues.some(issue => issue.code === "INVALID_TEMPLATE"))
    const detachedInput = clone(value)
    detachedInput.input = { ...detachedInput.input, sha256: "0".repeat(64) }
    assert.ok((await specialtySubcontractValidator(detachedInput)).issues.some(issue => issue.code === "INVALID_INPUT_VERSION"))
    const crossKind = await specialtySubcontractValidator({ ...clone(value), kind: "supplementary-agreement" })
    assert.equal(crossKind.status, "invalid")
  } finally { await fixture.close() }
})

test("C5 validator: decimal amounts and dates are preserved as strings and revalidated", async () => {
  const fixture = await setupDrafting()
  try {
    const draft = await fixture.saveSpecialtyDraft({ ...specialtyFields(), "pricing.amount": "0.01" })
    const value = clone(draft.value) as DraftingValue
    const amount = value.fields.find(field => field.fieldId === "pricing.amount")
    assert.equal(amount?.value, "0.01")
    assert.ok(value.paragraphs.some(paragraph => paragraph.includes("0.01")))
    const inspected = inspectDraftingValue(value, "specialty-subcontract")
    assert.ok(inspected.value)
    assert.equal(inspected.issues.length, 0)
  } finally { await fixture.close() }
})

test("C5 validator: supplementary agreement must embed a pinned original-contract reference", async () => {
  const fixture = await setupDrafting()
  try {
    const material = await fixture.addMaterial(["原合同正文。"], { title: "原专业分包合同" })
    const input = await fixture.saveInput("supplementary-agreement-v1", {
      "parties.employer": "发包人", "parties.contractor": "承包人", "change.kind": "other",
      "change.clause": "第 1 条", "change.content": "调整", "effect.condition": "签署生效", "signature.date": "2026-10-30",
    }, { originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId } })
    const draft = await fixture.generateDraft({ inputId: input.input.inputId })
    const value = clone(draft.value) as DraftingValue
    assert.equal((await supplementaryAgreementValidator(value)).status, "partial")
    const detached = clone(value)
    detached.originalContract = null as unknown as DraftingValue["originalContract"]
    assert.ok((await supplementaryAgreementValidator(detached)).issues.some(issue => issue.code === "INVALID_ORIGINAL_CONTRACT"))
    assert.equal((await specialtySubcontractValidator(value)).status, "invalid")
  } finally { await fixture.close() }
})

test("C5 matrix: partial drafts export as drafts but can never be approved; invalid drafts cannot be approved or exported", async () => {
  const fixture = await setupDrafting()
  try {
    const draft = await fixture.saveSpecialtyDraft()
    assert.equal(draft.validation.status, "partial")
    // Partial cannot be approved as a complete result (待核对 template).
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
    const exports = fixture.exportService()
    const created = await exports.createExport(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256,
    })
    const bytes = await exports.download(testIdentity, testAuthorizer, projectId, draft.resultId, created.exportId)
    const document = strFromU8(unzipSync(bytes)["word/document.xml"])
    assert.match(document, /待核对/)
    assert.match(document, /人工拟约定输入/)
    assert.match(document, /specialty-subcontract-v1/)
    assert.match(document, /确定性模板填充/)

    // A tampered invalid value is persisted for audit but can be neither approved nor exported.
    const invalid = clone(draft.value) as DraftingValue
    invalid.paragraphs = [...invalid.paragraphs]
    invalid.paragraphs[1] = "被篡改的模板说明"
    const saved = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "specialty-subcontract", baseVersionId: "", operationId: "tampered-invalid-1", reason: "篡改内容",
      value: invalid, sources: [], dependencies: [],
    }, undefined, { serverOwned: true })
    assert.equal(saved.validation.status, "invalid")
    await assert.rejects(fixture.results.reviewResult(testIdentity, testAuthorizer, {
      projectId, resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256, decision: "approved", comment: "同意",
    }), { code: "INVALID_SOURCE" })
    await assert.rejects(exports.createExport(testIdentity, testAuthorizer, {
      projectId, resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256,
    }), { code: "INVALID_SOURCE" })
    // The valid column is unreachable this round: both validators always return partial.
    assert.equal((await specialtySubcontractValidator(draft.value)).status, "partial")
  } finally { await fixture.close() }
})

test("C5 export templates: both draft kinds render provenance, pins, missing markers and disclaimers", async () => {
  const fixture = await setupDrafting()
  try {
    const material = await fixture.addMaterial(["原合同正文。"], { title: "原专业分包合同" })
    const input = await fixture.saveInput("supplementary-agreement-v1", {
      "parties.employer": "发包人", "parties.contractor": "承包人", "change.kind": "other",
      "change.clause": "第 1 条", "change.content": "调整", "effect.condition": "签署生效", "signature.date": "2026-10-30",
    }, { originalContract: { kind: "material", materialId: material.materialId, versionId: material.versionId } })
    const draft = await fixture.generateDraft({ inputId: input.input.inputId })
    const specialty = specialtySubcontractExportTemplate.paragraphs((await draftValue(fixture)))
    const supplementary = supplementaryAgreementExportTemplate.paragraphs(draft.value)
    for (const lines of [specialty, supplementary]) {
      const text = lines.join("\n")
      assert.match(text, /人工拟约定输入/)
      assert.match(text, /模板状态：待核对/)
      assert.match(text, /缺失字段/)
      assert.match(text, /不构成完整复核成果/)
    }
    assert.ok(supplementary.join("\n").includes("原专业分包合同"))
  } finally { await fixture.close() }
})

test("C5 export: a template/render upgrade creates a superseding export without changing old bytes", async () => {
  const fixture = await setupDrafting()
  try {
    const draft = await fixture.saveSpecialtyDraft()
    const originalExports = fixture.exportService()
    const first = await originalExports.createExport(testIdentity, testAuthorizer, {
      projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256,
    })
    const firstBytes = await originalExports.download(testIdentity, testAuthorizer, projectId, draft.resultId, first.exportId)
    // Simulate a template upgrade: a v2 export template over the same immutable result version.
    const upgraded = new ExportService(
      new ExportRepository(fixture.database), fixture.results, fixture.store,
      new ExportTemplateRegistry(new Map([["specialty-subcontract", {
        version: "specialty-subcontract-v2",
        blocksInvalidResult: true,
        originNote: "人工拟约定输入，确定性模板填充（无模型生成）",
        paragraphs: specialtySubcontractExportTemplate.paragraphs,
      }]])),
      async () => "2099-12-31",
    )
    const second = await upgraded.download(testIdentity, testAuthorizer, projectId, draft.resultId,
      (await upgraded.createExport(testIdentity, testAuthorizer, { projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256 })).exportId)
    assert.ok(second.byteLength > 0)
    const rows = await new ExportRepository(fixture.database).list(projectId, draft.resultId)
    assert.equal(rows.length, 2)
    const v2 = rows.find(row => row.template_version === "specialty-subcontract-v2")
    assert.ok(v2)
    assert.equal(v2!.supersedes_id, first.exportId)
    // The historical download still returns the original immutable bytes.
    const firstAgain = await originalExports.download(testIdentity, testAuthorizer, projectId, draft.resultId, first.exportId)
    assert.equal(Buffer.from(firstAgain).toString("hex"), Buffer.from(firstBytes).toString("hex"))
  } finally { await fixture.close() }
})
