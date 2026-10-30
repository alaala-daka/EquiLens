import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import type { LedgerRow, ProjectPaymentDraft } from "@/lib/payments/types"
import { setupDrafting, testIdentity, testAuthorizer, projectId } from "../drafting/drafting-test-fixtures"
import { FactRepository } from "../facts/repository"
import { ResultRepository } from "../results/repository"
import { ResultService } from "../results/service"
import { ResultValidatorRegistry } from "../results/validation"
import { ExportService, ExportTemplateRegistry } from "../exports/service"
import { ExportRepository } from "../exports/repository"
import { paymentReconciliationValidator } from "./result-validator"
import { paymentReconciliationExportTemplate } from "./export-template"
import { PaymentsService } from "./service"
import { paymentsHandler } from "./http"

async function fixture() {
  const base = await setupDrafting()
  const material = await base.addMaterial(["计量100万元，支付80%，已支付30万元。"])
  const fragment = (await base.materials.fragments(material.snapshotId))[0]
  const source = { projectId, materialId: material.materialId, materialVersionId: material.versionId, parseSnapshotId: material.snapshotId, fragmentId: fragment.id, quote: fragment.text }
  const common = { basis: "本期", taxBasis: "含税", confirmation: "已确认", payer: "总包", payee: "分包", periodStart: "2026-10-01", periodEnd: "2026-10-30", source } as const
  const rows: LedgerRow[] = [
    { ...common, rowId: "due", nature: "计付基数", amountFen: "100000000", ratio: "0.8", dueDate: "2026-10-30", conditionMet: true },
    { ...common, rowId: "paid", nature: "付款", amountFen: "30000000", eventDate: "2026-10-29", transactionId: "bank-001" },
  ]
  const draft: ProjectPaymentDraft = { cutoff: "2026-10-30", rows, facts: [] }
  const facts = new FactRepository(base.database)
  const results = new ResultService(new ResultRepository(base.database), new ResultValidatorRegistry(new Map([["payment-reconciliation", paymentReconciliationValidator]])), new Set(["payment-reconciliation"]), new Set(["payment-reconciliation"]))
  const service = new PaymentsService({ results, materials: base.materials, facts })
  const exports = new ExportService(new ExportRepository(base.database), results, base.store, new ExportTemplateRegistry(new Map([["payment-reconciliation", paymentReconciliationExportTemplate]])), async () => "2099-12-31")
  const input = { projectId, value: draft, operationId: "payment-initial", reason: "核对付款" }
  return { ...base, results, service, facts, source, draft, input, exports }
}

test("AC-06/09/10/11: save→validate→review→export, immutable revisions and idempotent retries", async () => {
  const f = await fixture()
  try {
    const first = await f.service.save(testIdentity, testAuthorizer, f.input)
    assert.equal(first.validation.status, "valid")
    assert.equal((first.value as { calculation: { unpaidFen: string } }).calculation.unpaidFen, "50000000")
    assert.equal((await f.service.save(testIdentity, testAuthorizer, f.input)).versionId, first.versionId)
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...f.input, reason: "不同内容" }), { code: "CONFLICT" })
    assert.equal((await f.results.validateResult(testIdentity, testAuthorizer, first)).status, "valid")
    const reviewed = await f.results.reviewResult(testIdentity, testAuthorizer, { ...first, decision: "approved", comment: "已核对" })
    assert.equal(reviewed.review?.versionId, first.versionId)
    const exported = await f.exports.createExport(testIdentity, testAuthorizer, first)
    assert.equal(exported.versionId, first.versionId)
    const secondInput = { ...f.input, resultId: first.resultId, baseVersionId: first.versionId, operationId: "payment-revision", value: { ...f.draft, rows: [f.draft.rows[0], { ...f.draft.rows[1], amountFen: "40000000" }] } }
    const second = await f.service.save(testIdentity, testAuthorizer, secondInput)
    assert.notEqual(second.versionId, first.versionId); assert.equal(second.review, null)
    assert.equal((await f.service.save(testIdentity, testAuthorizer, secondInput)).versionId, second.versionId)
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...secondInput, operationId: "stale-operation" }), { code: "CONFLICT" })
    assert.deepEqual((await f.results.get(testIdentity, testAuthorizer, projectId, first.resultId, first.versionId)).value, first.value)
    await assert.rejects(f.results.saveResultRevision(testIdentity, testAuthorizer, { ...f.input, kind: "payment-reconciliation", baseVersionId: "", sources: [], dependencies: [] }), { code: "FORBIDDEN" })
  } finally { await f.close() }
})

test("AC-19/20: unconfirmed rows save partial, cannot approve; invalid amounts and citations rejected", async () => {
  const f = await fixture()
  try {
    const draft = await f.service.save(testIdentity, testAuthorizer, { ...f.input, value: { ...f.draft, rows: f.draft.rows.map(row => ({ ...row, confirmation: "未确认" })) } })
    assert.equal(draft.validation.status, "partial")
    await assert.rejects(f.results.reviewResult(testIdentity, testAuthorizer, { ...draft, decision: "approved", comment: "" }), { code: "INVALID_SOURCE" })
    assert.equal((await f.exports.createExport(testIdentity, testAuthorizer, draft)).versionId, draft.versionId)
    const bad = (change: Partial<LedgerRow>) => ({ ...f.input, operationId: "bad-operation", value: { ...f.draft, rows: [{ ...f.draft.rows[0], ...change }] } })
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, bad({ amountFen: "1.2" })), { code: "INVALID_INPUT" })
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, bad({ source: { ...f.source, quote: "不在材料中的引文" } })), { code: "INVALID_SOURCE" })
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, bad({ source: { ...f.source, projectId: "foreign" } })), { code: "INVALID_SOURCE" })
    await f.database.transaction(c => c.query("UPDATE equilens_materials SET processing_authorized=0 WHERE id=$1", [f.source.materialId]))
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...f.input, operationId: "revoked-source" }), { code: "INVALID_SOURCE" })
  } finally { await f.close() }
})

test("AC-01/15/19: viewer, foreign results and missing/cross-project fact versions cannot save", async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.service.save(testIdentity, async (_identity, id, action) => ({ projectId: id, action, role: "viewer", identity: testIdentity }), f.input), { code: "FORBIDDEN" })
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...f.input, resultId: "foreign-result", baseVersionId: "foreign-version" }), { code: "NOT_FOUND" })
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...f.input, value: { ...f.draft, facts: [{ factId: "unknown", factVersionId: "unknown-version" }] } }), { code: "INVALID_SOURCE" })
    const fact = await f.facts.save(projectId, { projectId, field: "计量", nature: "材料记载", selectedValue: "100万元", sources: [f.source], conflicts: [], confirmation: "已确认", support: "材料支持", createdBy: testIdentity.account.id, reason: "核对" })
    const value = { ...f.draft, facts: [{ factId: fact.factId, factVersionId: fact.factVersionId }], rows: f.draft.rows.map(row => ({ ...row, source: undefined, factVersionIds: [fact.factVersionId] })) }
    const saved = await f.service.save(testIdentity, testAuthorizer, { ...f.input, value })
    assert.equal(saved.validation.status, "valid"); assert.ok(saved.dependencies.some(item => item.kind === "fact"))
    await assert.rejects(f.service.save(testIdentity, testAuthorizer, { ...f.input, operationId: "wrong-fact", value: { ...value, facts: [{ factId: "other", factVersionId: fact.factVersionId }] } }), { code: "INVALID_SOURCE" })
  } finally { await f.close() }
})

test("payment HTTP enforces origin, strict DTO, scoped route and private no-store", async () => {
  const f = await fixture()
  const originalOrigin = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = "https://equilens.example"
  try {
    const handler = paymentsHandler(async () => ({ identity: async () => testIdentity, authorize: testAuthorizer, service: f.service }))
    const request = (body: unknown, origin = "https://equilens.example") => new NextRequest("https://equilens.example/api/projects/p/payments", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const body = { value: f.draft, reason: "核对", operationId: "http-operation" }
    assert.equal((await handler(request(body, "http://foreign"), { params: Promise.resolve({ id: projectId }) })).status, 403)
    assert.equal((await handler(request({ ...body, serverOwned: true }), { params: Promise.resolve({ id: projectId }) })).status, 400)
    assert.equal((await handler(request({ ...body, value: { ...f.draft, calculation: {} } }), { params: Promise.resolve({ id: projectId }) })).status, 400)
    const saved = await handler(request(body), { params: Promise.resolve({ id: projectId }) })
    assert.equal(saved.status, 200); assert.equal(saved.headers.get("cache-control"), "private, no-store")
  } finally { if (originalOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originalOrigin; await f.close() }
})
