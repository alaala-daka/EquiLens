import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { canonicalJson } from "../results/validation"
import {
  DRAFTING_RENDER_VERSION, draftingFieldValueError, draftingTemplateById, draftingTemplateForKind,
  draftingTemplates, draftingTemplateView, isDraftingAmount, isDraftingDate, missingFields,
  templateViews, type DraftingField, type DraftingTemplate,
} from "./catalog"

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

test("C5 templates: the catalogue is code-versioned with fixed ids/versions/status and a matching sha", () => {
  assert.deepEqual(draftingTemplates.map(template => template.id), ["specialty-subcontract-v1", "supplementary-agreement-v1"])
  for (const template of draftingTemplates) {
    assert.equal(template.version, "v1")
    assert.equal(template.status, "待核对")
    assert.equal(template.sha256.length, 64)
    assert.equal(draftingTemplateById(template.id)?.id, template.id)
    assert.equal(draftingTemplateForKind(template.kind)?.id, template.id)
    const { sha256, ...definition } = template
    assert.equal(createHash("sha256").update(canonicalJson(definition)).digest("hex"), sha256)
    assert.equal(draftingTemplateView(template).sha256, sha256)
    assert.equal(draftingTemplateView(template).renderVersion, DRAFTING_RENDER_VERSION)
  }
  assert.equal(draftingTemplateById("unknown"), null)
  assert.equal(draftingTemplateForKind("contract-review"), null)
  assert.equal(templateViews().length, 2)
})

test("C5 templates: sections, fields, clauses and conditional requirements stay internally consistent", () => {
  for (const template of draftingTemplates) {
    const sectionIds = new Set(template.sections.map(section => section.id))
    const fieldIds = new Set(template.fields.map(field => field.id))
    assert.equal(fieldIds.size, template.fields.length)
    const labels = new Set(template.fields.map(field => field.label))
    assert.equal(labels.size, template.fields.length)
    const referenced = new Set<string>()
    for (const section of template.sections) {
      assert.ok(section.title.trim())
      for (const clause of section.clauses) {
        for (const match of clause.text.matchAll(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g)) referenced.add(match[1])
        if (clause.when) {
          assert.ok(fieldIds.has(clause.when.fieldId), `${template.id}: clause condition references unknown field`)
          const field = template.fields.find(item => item.id === clause.when!.fieldId)!
          assert.ok((field.choices ?? []).some(choice => choice.value === clause.when!.equals))
        }
      }
    }
    for (const field of template.fields) {
      assert.ok(sectionIds.has(field.section), `${template.id}: ${field.id} has unknown section`)
      assert.ok(field.label.trim() && field.maxLength > 0)
      if (field.required !== "always") {
        const condition = field.required.when
        assert.ok(fieldIds.has(condition.fieldId), `${template.id}: conditional field references unknown field`)
        assert.notEqual(condition.fieldId, field.id)
        const source = template.fields.find(item => item.id === condition.fieldId)!
        assert.ok((source.choices ?? []).some(choice => choice.value === condition.equals))
      }
      if (field.kind === "choice") assert.ok((field.choices ?? []).length >= 2)
      else assert.equal(field.choices, undefined)
    }
    for (const fieldId of fieldIds) assert.ok(referenced.has(fieldId), `${template.id}: field ${fieldId} is never rendered`)
    for (const reference of referenced) {
      if (reference.startsWith("originalContract.")) continue
      assert.ok(fieldIds.has(reference), `${template.id}: clause references unknown field ${reference}`)
    }
  }
  const specialty = draftingTemplates[0], supplementary = draftingTemplates[1]
  assert.equal(specialty.originalContract, null)
  assert.deepEqual(supplementary.originalContract?.allowed.map(item => item.kind), ["material", "result"])
})

test("C5 templates: required and conditional-required fields drive the missing list in template order", () => {
  const template = draftingTemplates[0]
  const empty = missingFields(template, {})
  assert.deepEqual(empty.map(item => item.fieldId),
    template.fields.filter(field => field.required === "always").map(field => field.id))
  assert.ok(empty.every(item => item.reason === "required"))
  const withUnitPrice = missingFields(template, { "pricing.mode": "unit_price", "payment.hasPrepayment": "no" })
  assert.ok(withUnitPrice.some(item => item.fieldId === "pricing.unitRule" && item.reason === "conditional"))
  assert.equal(withUnitPrice.some(item => item.fieldId === "payment.prepayRatio"), false)
  const withPrepayment = missingFields(template, { "pricing.mode": "fixed_total", "payment.hasPrepayment": "yes" })
  assert.ok(withPrepayment.some(item => item.fieldId === "payment.prepayRatio" && item.reason === "conditional"))
  assert.equal(withPrepayment.some(item => item.fieldId === "pricing.unitRule"), false)
  const filled = missingFields(template, completeValues(template))
  assert.equal(filled.length, 0)
})

test("C5 templates: amount/date/choice source values are validated without numeric coercion", () => {
  assert.equal(isDraftingAmount("1000000.00"), true)
  assert.equal(isDraftingAmount("0.01"), true)
  assert.equal(isDraftingAmount("9007199254740993.01"), false)
  for (const invalid of ["1,000.00", "1e3", "12.345", "-5", "abc", "１００"]) assert.equal(isDraftingAmount(invalid), false, invalid)
  assert.equal(isDraftingDate("2026-10-30"), true)
  for (const invalid of ["2026-02-30", "2026-13-01", "2026-1-1", "20261030", "abc"]) assert.equal(isDraftingDate(invalid), false, invalid)
  const amountField = draftingTemplates[0].fields.find(field => field.kind === "amount")!
  assert.equal(draftingFieldValueError(amountField, "1000.00"), null)
  assert.match(draftingFieldValueError(amountField, "1,000.00") ?? "", /金额/)
  const dateField = draftingTemplates[0].fields.find(field => field.kind === "date")!
  assert.match(draftingFieldValueError(dateField, "2026-02-30") ?? "", /日期/)
  const choiceField = draftingTemplates[0].fields.find(field => field.kind === "choice")!
  assert.equal(draftingFieldValueError(choiceField, "fixed_total"), null)
  assert.match(draftingFieldValueError(choiceField, "unknown") ?? "", /选项/)
  const textField: DraftingField = { ...draftingTemplates[0].fields[0], maxLength: 4 }
  assert.match(draftingFieldValueError(textField, "过长文本内容") ?? "", /长度/)
})

function completeValues(template: DraftingTemplate): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of template.fields) {
    if (field.kind === "amount") values[field.id] = "1000000.00"
    else if (field.kind === "date") values[field.id] = "2026-10-30"
    else if (field.kind === "choice") values[field.id] = field.choices![0].value
    else values[field.id] = "测试值"
  }
  return values
}

test("C5 templates: a definition digest cannot be forged by editing copy or status", () => {
  const template = draftingTemplates[0]
  const { sha256, ...definition } = clone(template)
  const tampered = { ...definition, status: "待核对" as const, label: definition.label + "（伪）" }
  assert.notEqual(createHash("sha256").update(canonicalJson(tampered)).digest("hex"), sha256)
  const detachedField = { ...template.fields[0], label: template.fields[0].label + "改" }
  const tamperedFields = { ...definition, fields: [detachedField, ...definition.fields.slice(1)] }
  assert.notEqual(createHash("sha256").update(canonicalJson(tamperedFields)).digest("hex"), sha256)
})
