import assert from "node:assert/strict"
import { test } from "node:test"
import { projectId, setupReview, testIdentity, testAuthorizer, type ReviewFixture } from "../reviews/test-fixtures"
import { FactRepository } from "../facts/repository"
import { ResultRepository } from "../results/repository"
import { ResultService, type ResultAuthorizer } from "../results/service"
import { ResultValidatorRegistry } from "../results/validation"
import { EvidenceProjectService, saveEvidenceItemSchema, saveEvidenceReportSchema } from "./project-service"
import { EvidenceRepository } from "./repository"
import { evidenceReportExportTemplate } from "./export-template"
import { evidenceReportValidator, parseEvidenceReportValue } from "./result-validator"

const quote = "合同价款按月度计量支付。"
const source = (f: ReviewFixture) => ({ projectId, materialId: f.materials[0].materialId, materialVersionId: f.materials[0].versionId,
  parseSnapshotId: f.materials[0].snapshotId, fragmentId: "fragment-1-0", quote })
const itemDraft = (f: ReviewFixture) => ({ kind: "材料事实" as const, title: "合同价款", occurredAt: "2026-10-01",
  sources: [source(f)], conflicts: [], confirmation: "已确认" as const, support: "材料支持" as const, links: [] })

function service(f: ReviewFixture) {
  const results = new ResultService(new ResultRepository(f.database), new ResultValidatorRegistry(new Map([["evidence-report", evidenceReportValidator]])),
    new Set(["evidence-report"]), new Set(["evidence-report"]))
  return { results, evidence: new EvidenceProjectService({ repository: new EvidenceRepository(f.database), materials: f.repository,
    facts: new FactRepository(f.database), results, readProjectRetention: async () => f.projectRetention }) }
}

test("AC-06/19: evidence items save idempotently, keep immutable versions and reject stale corrections", async () => {
  const f = await setupReview()
  try {
    const { evidence } = service(f)
    const input = { operationId: "item-1", baseVersionId: "", reason: "整理合同依据", value: itemDraft(f) }
    const first = await evidence.saveItem(testIdentity, testAuthorizer, projectId, input)
    assert.ok(first.versionId)
    assert.equal(first.support, "材料支持")
    assert.equal((await evidence.saveItem(testIdentity, testAuthorizer, projectId, input)).versionId, first.versionId)
    await assert.rejects(evidence.saveItem(testIdentity, testAuthorizer, projectId, { ...input, reason: "不同内容" }), { code: "CONFLICT" })
    const correction = { ...input, itemId: first.itemId, baseVersionId: first.versionId, operationId: "item-2", reason: "更正金额口径", value: { ...itemDraft(f), selectedValue: "1000000.00" } }
    const second = await evidence.saveItem(testIdentity, testAuthorizer, projectId, correction)
    assert.equal(second.supersedesVersionId, first.versionId)
    assert.equal((await evidence.history(testIdentity, testAuthorizer, projectId, first.itemId)).length, 2)
    await assert.rejects(evidence.saveItem(testIdentity, testAuthorizer, projectId, { ...correction, operationId: "item-3" }), { code: "CONFLICT" })
    await assert.rejects(evidence.history(testIdentity, testAuthorizer, "other-project", first.itemId), { code: "NOT_FOUND" })
  } finally { await f.close() }
})

test("AC-15/19: evidence items recheck material sources, project scope and roles", async () => {
  const f = await setupReview()
  try {
    const { evidence } = service(f)
    const base = { operationId: "bad", baseVersionId: "", reason: "整理", value: itemDraft(f) }
    for (const change of [{ quote: "编造的引文" }, { projectId: "other-project" }, { parseSnapshotId: "other-snapshot" }, { materialVersionId: "other-version" }])
      await assert.rejects(evidence.saveItem(testIdentity, testAuthorizer, projectId, { ...base, value: { ...base.value, sources: [{ ...source(f), ...change }] } }), { code: "INVALID_SOURCE" })
    const viewer: ResultAuthorizer = async (identity, id, action) => ({ projectId: id, action, role: "viewer", identity })
    await assert.rejects(evidence.saveItem(testIdentity, viewer, projectId, base), { code: "FORBIDDEN" })
    assert.equal((await evidence.listItems(testIdentity, viewer, projectId)).length, 0)
  } finally { await f.close() }
})

test("AC-06/19/20: evidence report derives status, saves an immutable result and exports the selected version", async () => {
  const f = await setupReview()
  try {
    const { evidence } = service(f)
    const item = await evidence.saveItem(testIdentity, testAuthorizer, projectId, { operationId: "item-1", baseVersionId: "", reason: "整理合同依据", value: itemDraft(f) })
    const draft = { cutoff: "2026-10-30", itemVersionIds: [item.versionId],
      timeline: [{ id: "t1", at: "2026-10-01", title: "签订合同", evidenceVersionIds: [item.versionId] }],
      disputes: [], gaps: [], suggestions: [{ id: "s1", text: "补充履约材料", dependsOnVersionIds: [item.versionId] }] }
    const saved = await evidence.saveReport(testIdentity, testAuthorizer, projectId, { operationId: "report-1", reason: "生成证据报告", baseVersionId: "", value: draft })
    assert.equal(saved.kind, "evidence-report")
    assert.equal(saved.validation.status, "valid")
    const value = saved.value as { status: string; scopeNotes: string[]; items: Array<{ itemId: string }> }
    assert.equal(value.status, "draft")
    assert.deepEqual(value.scopeNotes, [])
    assert.equal(value.items[0].itemId, item.itemId)
    assert.equal(parseEvidenceReportValue(saved.value)?.cutoff, "2026-10-30")
    // 篡改派生状态或报告条目即失效
    assert.equal((await evidenceReportValidator({ ...saved.value as object, status: "incomplete" })).status, "invalid")
    assert.equal((await evidenceReportValidator({ ...saved.value as object, items: [] })).status, "invalid")
    const revision = await evidence.saveReport(testIdentity, testAuthorizer, projectId, { operationId: "report-2", reason: "修订报告", baseVersionId: saved.versionId,
      resultId: saved.resultId, value: { ...draft, gaps: [{ id: "g1", description: "缺少计量单", status: "开放" }] } })
    assert.notEqual(revision.versionId, saved.versionId)
    assert.equal(revision.review, null)
    assert.equal(revision.validation.status, "partial")
    await assert.rejects(evidence.saveReport(testIdentity, testAuthorizer, projectId, { operationId: "report-3", reason: "过期基础版本", baseVersionId: saved.versionId, resultId: saved.resultId, value: draft }), { code: "CONFLICT" })
    const lines = evidenceReportExportTemplate.paragraphs(revision.value)
    assert.ok(lines.some(line => line.includes("缺少计量单")))
    assert.ok(lines.some(line => line.includes("人工整理草稿")))
  } finally { await f.close() }
})

test("evidence schemas reject unknown keys and empty item selections", () => {
  const draft = { kind: "材料事实", title: "合同价款", sources: [], conflicts: [], confirmation: "已确认", support: "仅人工陈述", links: [] }
  assert.equal(saveEvidenceItemSchema.safeParse({ operationId: "op", baseVersionId: "", reason: "整理", value: draft }).success, true)
  assert.equal(saveEvidenceItemSchema.safeParse({ operationId: "op", baseVersionId: "", reason: "整理", value: { ...draft, extra: true } }).success, false)
  assert.equal(saveEvidenceReportSchema.safeParse({ operationId: "op", baseVersionId: "", reason: "报告", value: { cutoff: "2026-10-30", itemVersionIds: [], timeline: [], disputes: [], gaps: [], suggestions: [] } }).success, false)
})
