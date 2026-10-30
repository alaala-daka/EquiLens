import assert from "node:assert/strict"
import { test } from "node:test"
import {
  checkGenerateDraft, checkSaveInput, conditionalFieldIds, draftMissingCount, draftResultLabel, draftingEmptyState,
  emptyDraftingForm, fieldValueError, fieldsBySection, formFingerprint, formFromSavedInput, isDraftingFormDirty,
  missingPreview, needsRegeneration, nextDraftingOperation, originalContractOptions, originalContractSelection,
  parseOriginalContractSelection, readDraftValue, reviewDecisionOptions, reviewLabel, validationLabel,
  type DraftingForm,
} from "./drafting-form"
import type { DraftingInputView, DraftingTemplateView, DraftingValueView, ProjectResultView } from "@/lib/business/drafting-client"

const template: DraftingTemplateView = {
  id: "specialty-subcontract-v1", kind: "specialty-subcontract", version: "v1", sha256: "a".repeat(64), status: "待核对",
  label: "专业分包合同", summary: "测试", renderVersion: "drafting-render-v1", originalContract: null,
  sections: [{ id: "project", title: "项目与地点" }, { id: "pricing", title: "计价与价款" }],
  fields: [
    { id: "project.name", label: "项目名称", section: "project", kind: "text", required: "always", source: "proposed", maxLength: 20 },
    { id: "pricing.mode", label: "计价方式", section: "pricing", kind: "choice", required: "always", source: "proposed", maxLength: 32, choices: [{ value: "fixed_total", label: "固定总价" }, { value: "unit_price", label: "单价" }] },
    { id: "pricing.unitRule", label: "单价规则", section: "pricing", kind: "text", required: { when: { fieldId: "pricing.mode", equals: "unit_price" } }, source: "proposed", maxLength: 50 },
    { id: "pricing.amount", label: "合同价款", section: "pricing", kind: "amount", required: "always", source: "proposed", maxLength: 24 },
  ],
}

const savedForm = (): DraftingForm => ({
  ...emptyDraftingForm(template.id),
  values: { "project.name": "项目甲", "pricing.mode": "fixed_total", "pricing.amount": "1000.00" },
  inputId: "input-1", versionId: "version-1", version: 1, sha256: "b".repeat(64),
  savedFingerprint: formFingerprint({ templateId: template.id, values: { "project.name": "项目甲", "pricing.mode": "fixed_total", "pricing.amount": "1000.00" }, originalContract: null }),
})

test("C5 form: dirty state compares against the last saved proposed-input version", () => {
  const saved = savedForm()
  assert.equal(isDraftingFormDirty(saved), false)
  assert.equal(isDraftingFormDirty({ ...saved, values: { ...saved.values, "pricing.amount": "1001.00" } }), true)
  const orderA = formFingerprint({ templateId: "t", values: { b: "2", a: "1" }, originalContract: null })
  const orderB = formFingerprint({ templateId: "t", values: { a: "1", b: "2" }, originalContract: null })
  assert.equal(orderA, orderB)
  assert.equal(isDraftingFormDirty(emptyDraftingForm(template.id)), false)
  assert.equal(isDraftingFormDirty({ ...emptyDraftingForm(template.id), values: { "project.name": "新项目" } }), true)
  assert.equal(isDraftingFormDirty(emptyDraftingForm(template.id)), false)
})

test("C5 form: conditional requirements follow the selected values", () => {
  assert.deepEqual([...conditionalFieldIds(template, { "pricing.mode": "fixed_total" })], [])
  assert.deepEqual([...conditionalFieldIds(template, { "pricing.mode": "unit_price" })], ["pricing.unitRule"])
  const missing = missingPreview(template, { "project.name": "项目甲" })
  assert.ok(missing.some(field => field.fieldId === "pricing.amount" && field.reason === "required"))
  assert.equal(missing.some(field => field.fieldId === "pricing.unitRule"), false)
  const unitMissing = missingPreview(template, { "project.name": "项目甲", "pricing.mode": "unit_price" })
  assert.ok(unitMissing.some(field => field.fieldId === "pricing.unitRule" && field.reason === "conditional"))
})

test("C5 form: save validation catches invalid amount/date/choice and unknown fields", () => {
  assert.match(fieldValueError(template.fields[3], "1,000.00") ?? "", /金额/)
  assert.equal(fieldValueError(template.fields[3], "1000"), null)
  const issues = checkSaveInput(template, { ...emptyDraftingForm(template.id), values: { "pricing.amount": "1,000.00", "project.unknown": "x" } }, true)
  assert.equal(issues.ok, false)
  assert.ok(issues.issues.some(issue => issue.includes("金额")))
  assert.ok(issues.issues.some(issue => issue.includes("未登记")))
  assert.equal(checkSaveInput(template, savedForm(), true).ok, true)
  assert.equal(checkSaveInput(template, savedForm(), false).ok, false)
  const supplementaryTemplate: DraftingTemplateView = {
    ...template, id: "supplementary-agreement-v1", kind: "supplementary-agreement",
    originalContract: { required: true, allowed: [{ kind: "material" }, { kind: "result", resultKind: "specialty-subcontract" }] },
  }
  assert.equal(checkSaveInput(supplementaryTemplate, emptyDraftingForm(supplementaryTemplate.id), true).ok, false)
})

test("C5 form: a draft can only be generated from a saved, clean proposed-input version", () => {
  assert.equal(checkGenerateDraft(template, emptyDraftingForm(template.id), true).ok, false)
  assert.equal(checkGenerateDraft(template, savedForm(), true).ok, true)
  assert.equal(checkGenerateDraft(template, { ...savedForm(), values: { ...savedForm().values, "project.name": "改" } }, true).ok, false)
  assert.equal(checkGenerateDraft(template, savedForm(), false).ok, false)
  const supplementaryTemplate: DraftingTemplateView = {
    ...template, id: "supplementary-agreement-v1", kind: "supplementary-agreement",
    originalContract: { required: true, allowed: [{ kind: "material" }] },
  }
  const missingOriginal = checkGenerateDraft(supplementaryTemplate, { ...savedForm(), templateId: supplementaryTemplate.id }, true)
  assert.equal(missingOriginal.ok, false)
  assert.ok(missingOriginal.issues.some(issue => issue.includes("原合同")))
})

test("C5 form: original-contract selector encodes material and specialty-result pins", () => {
  const materialOption = originalContractOptions([{ id: "material-1", title: "原合同", versionId: "material-version-1" }], [])
  assert.equal(materialOption.length, 1)
  const selection = materialOption[0].value
  assert.equal(originalContractSelection(materialOption[0].ref), selection)
  const parsed = parseOriginalContractSelection(selection, materialOption)
  assert.equal(parsed?.kind, "material")
  assert.equal(parsed?.id, "material-1")
  const specialtyValue = { ...baseValue(), kind: "specialty-subcontract" as const, template: { ...baseValue().template, id: "specialty-subcontract-v1" } }
  const resultOption = originalContractOptions([], [resultView("specialty-subcontract", specialtyValue, "result-1")])
  assert.equal(resultOption.length, 1)
  assert.equal(resultOption[0].ref.kind, "result")
  assert.equal(parseOriginalContractSelection("", resultOption), null)
})

function baseValue(): DraftingValueView {
  return {
    schemaVersion: 1, kind: "specialty-subcontract", status: "partial",
    template: { id: "specialty-subcontract-v1", version: "v1", sha256: "a".repeat(64), status: "待核对" },
    input: { inputId: "input-1", versionId: "version-1", version: 1, sha256: "b".repeat(64) },
    fields: [], originalContract: null, missing: [], paragraphs: ["草稿正文"], warnings: [{ code: "TEMPLATE_UNREVIEWED", message: "待核对" }],
    renderVersion: "drafting-render-v1",
  }
}

function resultView(kind: string, value: unknown, resultId: string): ProjectResultView {
  return {
    projectId: "p", resultId, versionId: "version-" + resultId, sha256: "c".repeat(64), kind, value, machineOutput: null,
    origin: "human", sources: [], dependencies: [], provenance: null,
    validation: { status: "partial", versionId: "version-" + resultId, checkedAt: "2026-10-29T00:00:00.000Z", issues: [] },
    review: null, createdAt: "2026-10-29T00:00:00.000Z", createdBy: "a", reason: "生成",
  }
}

test("C5 form: saved views hydrate a clean form and draft values are read defensively", () => {
  const view: DraftingInputView = {
    template,
    input: {
      inputId: "input-1", kind: "specialty-subcontract", templateId: template.id, templateLabel: template.label,
      templateStatus: "待核对", templateVersion: "v1", templateSha256: template.sha256, version: 2, versionId: "version-2",
      sha256: "b".repeat(64), createdAt: "2026-10-29T00:00:00.000Z", createdBy: "a", missingCount: 1,
      originalContractTitle: null, values: { "project.name": "项目甲" }, originalContract: null,
      missing: [{ fieldId: "pricing.amount", label: "合同价款", section: "pricing", reason: "required" }],
    },
  }
  const form = formFromSavedInput(view)
  assert.equal(isDraftingFormDirty(form), false)
  assert.equal(form.versionId, "version-2")
  assert.equal(form.inputId, "input-1")
  assert.equal(readDraftValue(baseValue())?.kind, "specialty-subcontract")
  assert.equal(readDraftValue({ ...baseValue(), schemaVersion: 2 }), null)
  assert.equal(readDraftValue({ ...baseValue(), template: { ...baseValue().template, status: "已发布" } }), null)
  assert.equal(readDraftValue({ ...baseValue(), paragraphs: "not-an-array" }), null)
  const draft = resultView("specialty-subcontract", baseValue(), "r1")
  assert.equal(draftResultLabel(draft), "专业分包合同（v1）")
  assert.equal(draftMissingCount(draft), 0)
  assert.equal(needsRegeneration(draft, savedForm()), false)
  assert.equal(needsRegeneration(draft, { ...savedForm(), versionId: "version-other" }), true)
})

test("C5 form: read-only gating, labels and operation-id reuse are deterministic", () => {
  assert.equal(checkSaveInput(template, savedForm(), false).issues[0], "只读成员不能保存拟约定输入。")
  assert.equal(validationLabel("partial"), "部分完成（待核对模板草稿）")
  assert.equal(reviewLabel(null), "待复核")
  assert.equal(reviewLabel("changes_requested"), "退回修改")
  assert.deepEqual(reviewDecisionOptions("partial").map(option => option.value), ["changes_requested", "rejected"])
  assert.equal(draftingEmptyState("inputs"), "暂无拟约定输入")
  assert.equal(fieldsBySection(template).length, 2)
  let created = 0
  const create = () => `op-${++created}`
  const first = nextDraftingOperation(null, "signature-a", create)
  assert.equal(nextDraftingOperation(first, "signature-a", create), first)
  assert.notEqual(nextDraftingOperation(first, "signature-b", create).key, first.key)
  assert.equal(created, 2)
})
