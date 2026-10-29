import assert from "node:assert/strict"
import { test } from "node:test"
import { draftingTemplateById, missingFields, type DraftingTemplate } from "../templates/catalog"
import { fillClause, missingMarker, renderDraft, type DraftingRenderInput } from "./render"
import { specialtyFields, supplementaryFields } from "./drafting-test-fixtures"
import type { DraftingOriginalContractRef } from "./render"

const specialty = draftingTemplateById("specialty-subcontract-v1")!
const supplementary = draftingTemplateById("supplementary-agreement-v1")!

const meta = { inputId: "input-1", versionId: "input-version-1", version: 1, sha256: "a".repeat(64) }

const originalMaterial: DraftingOriginalContractRef = { kind: "material", id: "material-1", versionId: "material-version-1", title: "原专业分包合同", sha256: "b".repeat(64) }

function render(template: DraftingTemplate, values: Record<string, string>, originalContract: DraftingOriginalContractRef | null = null, input = meta) {
  return renderDraft({ template, values, originalContract, input })
}

function inputFor(template: DraftingTemplate, values: Record<string, string>, originalContract: DraftingOriginalContractRef | null = null): DraftingRenderInput {
  return { template, values, originalContract, input: meta }
}

test("C5 render: identical inputs produce byte-identical paragraphs and missing lists", () => {
  const first = render(specialty, specialtyFields())
  const second = render(specialty, { ...specialtyFields() })
  assert.deepEqual(first, second)
  assert.equal(first.paragraphs.length, second.paragraphs.length)
  assert.deepEqual(render(specialty, specialtyFields(), null).paragraphs, first.paragraphs)
})

test("C5 render: absent values render as 【待补充：标签】 and never invent content", () => {
  const empty = render(specialty, {})
  const joined = empty.paragraphs.join("\n")
  assert.ok(joined.includes("【待补充：项目名称】"))
  assert.ok(joined.includes("【待补充：合同价款（元）】"))
  assert.ok(joined.includes("【待补充：拟签署日期】"))
  for (const marker of empty.missing) assert.ok(joined.includes(missingMarker(marker.label)))
  assert.equal(empty.missing.length, missingFields(specialty, {}).length)
  // Nothing but the fixed template copy is present: no fabricated names, money, dates or legal numbers.
  assert.equal(joined.includes("有限公司"), false)
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(joined), false)
  assert.equal(/\d+\.\d{2}/.test(joined), false)
  assert.equal(/第\s*\d+\s*条/.test(joined), false)
  assert.equal(joined.includes("AI"), false)
})

test("C5 render: conditional fields and clauses follow the proposed choice values", () => {
  const noPrepayment = render(specialty, specialtyFields({ "payment.hasPrepayment": "no" }))
  assert.equal(noPrepayment.missing.some(item => item.fieldId === "payment.prepayRatio"), false)
  assert.equal(noPrepayment.paragraphs.join("\n").includes("预付款比例"), false)
  const yesPrepayment = render(specialty, { ...specialtyFields(), "payment.hasPrepayment": "yes" })
  assert.ok(yesPrepayment.missing.some(item => item.fieldId === "payment.prepayRatio" && item.reason === "conditional"))
  assert.ok(yesPrepayment.paragraphs.join("\n").includes("【待补充：预付款比例】"))
  const unit = render(specialty, { ...specialtyFields(), "pricing.mode": "unit_price" })
  assert.ok(unit.missing.some(item => item.fieldId === "pricing.unitRule" && item.reason === "conditional"))
  assert.ok(unit.paragraphs.join("\n").includes("【待补充：单价计价规则】"))
})

test("C5 render: the supplementary agreement renders the pinned original contract title and version", () => {
  const rendered = render(supplementary, supplementaryFields(), originalMaterial)
  const joined = rendered.paragraphs.join("\n")
  assert.ok(joined.includes("原专业分包合同"))
  assert.ok(joined.includes("material-version-1"))
  assert.ok(joined.includes("第 1 版"))
  assert.equal(joined.includes("【待补充：原合同标题】"), false)
  const detached = render(supplementary, supplementaryFields(), null)
  assert.ok(detached.paragraphs.join("\n").includes("【待补充：原合同标题】"))
})

test("C5 render: changing one proposed value only re-renders the affected clause", () => {
  const base = render(specialty, specialtyFields())
  const changed = render(specialty, specialtyFields({ "payment.terms": "验收合格后一次性支付" }))
  assert.equal(base.paragraphs.length, changed.paragraphs.length)
  const differences = base.paragraphs.map((paragraph, index) => paragraph === changed.paragraphs[index] ? null : index).filter(index => index !== null)
  assert.equal(differences.length, 1)
  assert.ok(changed.paragraphs[differences[0]!].includes("验收合格后一次性支付"))
})

test("C5 render: the document is structured with fixed sections and an unsigned-template disclaimer", () => {
  const rendered = render(specialty, specialtyFields())
  assert.match(rendered.paragraphs[0], /专业分包合同（草稿）/)
  assert.ok(rendered.paragraphs.some(paragraph => paragraph.includes("模板状态：待核对")))
  assert.ok(rendered.paragraphs.some(paragraph => paragraph.includes("拟约定输入：第 1 版")))
  for (const [index, section] of specialty.sections.entries()) {
    assert.ok(rendered.paragraphs.includes(`${index + 1}. ${section.title}`), section.title)
  }
  assert.ok(rendered.paragraphs.at(-1)?.includes("待核对"))
  assert.ok(rendered.paragraphs.at(-1)?.includes("提示："))
})

test("C5 render: clause filling cannot inject placeholders outside the template allowlist", () => {
  const template = supplementary
  assert.equal(fillClause(template, "原合同：{originalContract.title}。", {}, null), "原合同：【待补充：原合同标题】。")
  assert.equal(fillClause(template, "{notAField}", { notAField: "浏览器注入" }, null), "【待补充：notAField】")
  assert.equal(fillClause(specialty, "{project.name}", { "project.name": "正常项目" }, null), "正常项目")
  const input = inputFor(specialty, specialtyFields())
  assert.deepEqual(renderDraft(input), renderDraft({ ...input, values: { ...input.values } }))
})
