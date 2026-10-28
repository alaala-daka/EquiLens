import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "@/server/database/connection"
import { EvidenceRepository } from "@/server/evidence/repository"
import { createEvidenceService } from "@/server/evidence/service"
import { testScope, normalCase, conflictCase } from "@/server/evidence/fixtures"
import type { EvidenceItemInput } from "@/lib/evidence/types"

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-evidence-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  const repository = new EvidenceRepository(database)
  await repository.initialize()
  return { directory, database, repository }
}
async function close(value: Awaited<ReturnType<typeof setup>>) { await value.database.close(); await rm(value.directory, { recursive: true }) }

test("AC-06/07/19: normal evidence saves versions and exports a traceable timeline, disputes and catalog", async () => {
  const s = await setup()
  try {
    const data = normalCase("project-normal")
    const service = createEvidenceService({ repository: s.repository, scope: testScope({ projectId: "project-normal",
      documents: ["doc-contract-v1", "doc-measure-v1", "doc-payment-v1", "doc-notice-v1"], facts: ["fact-measure:fact-measure-v1"], payments: ["ledger-rev-1:row-1"] }) })
    const saved = []
    for (const item of data.items) saved.push(await service.saveItem(item))
    assert.equal(saved.length, 4)
    const versions = Object.fromEntries(saved.map(item => [item.itemId, item.versionId]))
    const { report, markdown } = await service.saveReport({ ...data.report, items: saved,
      timeline: data.report.timeline.map(event => ({ ...event, evidenceVersionIds: [versions["item-" + (event.id === "t1" ? "contract" : event.id === "t2" ? "measure" : event.id === "t3" ? "payment" : "notice")]] })),
      disputes: data.report.disputes.map(dispute => ({ ...dispute, evidenceVersionIds: [versions["item-payment"], versions["item-measure"]] })) })
    assert.equal(report.status, "draft")
    assert.equal(report.reviewStatus, "待复核")
    assert.match(markdown, /## 时间线/)
    assert.match(markdown, /## 证据对应表/)
    assert.match(markdown, /进度款按经确认计量款的80%支付/)
    assert.match(markdown, /争议主张，不计入已确认金额/)
    const loaded = await s.repository.report("project-normal", report.revisionId)
    assert.equal(loaded.sha256, report.sha256)
  } finally { await close(s) }
})

test("AC-06/10: conflicting payment evidence and open gaps keep the report incomplete", async () => {
  const s = await setup()
  try {
    const data = conflictCase("project-conflict")
    const service = createEvidenceService({ repository: s.repository, scope: testScope({ projectId: "project-conflict",
      documents: ["doc-payment-a-v1", "doc-payment-b-v1"] }) })
    const saved = await service.saveItem(data.items[0])
    const { report, markdown } = await service.saveReport({ ...data.report, items: [saved],
      timeline: data.report.timeline.map(event => ({ ...event, evidenceVersionIds: [saved.versionId] })),
      disputes: data.report.disputes.map(dispute => ({ ...dispute, evidenceVersionIds: [saved.versionId] })) })
    assert.equal(report.status, "incomplete")
    assert.ok(report.scopeNotes.some(note => note.includes("材料冲突")))
    assert.ok(report.scopeNotes.some(note => note.includes("缺口")))
    assert.match(markdown, /未完成（存在冲突、缺证或待核实项）/)
    assert.match(markdown, /待关联：payment/)
  } finally { await close(s) }
})

test("AC-07/10/19: duplicate attachments, stale sources, float amounts and cross-project references are rejected", async () => {
  const s = await setup()
  try {
    const data = normalCase("project-normal")
    const base = data.items[0]
    const scope = testScope({ projectId: "project-normal", documents: ["doc-contract-v1", "doc-measure-v1"] })
    const service = createEvidenceService({ repository: s.repository, scope })
    await assert.rejects(service.saveItem({ ...base, sources: [base.sources[0], base.sources[0]], links: [] }), { code: "EVIDENCE_SOURCE_DUPLICATE" })
    await assert.rejects(service.saveItem({ ...base, sources: [{ ...base.sources[0], documentVersionId: "doc-old" }], links: [] }), { code: "EVIDENCE_SOURCE_UNAVAILABLE" })
    await assert.rejects(service.saveItem({ ...base, sources: [{ ...base.sources[0], projectId: "other-project" }], links: [] }), { code: "EVIDENCE_PROJECT_MISMATCH" })
    const factItem = { ...data.items[1], links: [{ kind: "fact" as const, factId: "fact-other", factVersionId: "fact-other-v1" }] }
    await assert.rejects(service.saveItem(factItem), { code: "EVIDENCE_LINK_UNAVAILABLE" })
    const report = { ...data.report, items: [base as never] }
    await assert.rejects(service.saveReport({ ...report, disputes: [{ ...data.report.disputes[0], claimAmountFen: "500.5" }] }), { code: "EVIDENCE_AMOUNT_INVALID" })
  } finally { await close(s) }
})

test("AC-08/09: a new saved version preserves the old evidence and report; manual revisions keep their base", async () => {
  const s = await setup()
  try {
    const data = normalCase("project-normal")
    const service = createEvidenceService({ repository: s.repository, scope: testScope({ projectId: "project-normal",
      documents: ["doc-contract-v1"], facts: [], payments: [] }) })
    const first = await service.saveItem(data.items[0])
    const { report } = await service.saveReport({ ...data.report, items: [first], timeline: [], disputes: [], gaps: [], suggestions: [] })
    const corrected: EvidenceItemInput & { itemId: string } = { ...data.items[0], itemId: first.itemId, selectedValue: "按 90% 支付", originalValue: "按 80% 支付", reason: "复核合同变更" }
    const second = await service.saveItem(corrected)
    assert.equal(second.supersedesVersionId, first.versionId)
    assert.equal((await s.repository.item("project-normal", first.versionId)).selectedValue, undefined)
    assert.equal((await s.repository.latestItem("project-normal", first.itemId))?.versionId, second.versionId)
    assert.equal((await s.repository.report("project-normal", report.revisionId)).sha256, report.sha256)
  } finally { await close(s) }
})

test("AC-19: evidence versions are project-scoped and tampering is detected", async () => {
  const s = await setup()
  try {
    const data = normalCase("project-normal")
    const service = createEvidenceService({ repository: s.repository, scope: testScope({ projectId: "project-normal", documents: ["doc-contract-v1"] }) })
    const saved = await service.saveItem(data.items[0])
    await assert.rejects(s.repository.item("other-project", saved.versionId), { code: "EVIDENCE_NOT_FOUND" })
    const row = (await s.database.transaction(c => c.query("SELECT payload FROM equilens_evidence_items WHERE version_id=$1", [saved.versionId]))).rows[0]
    const payload = JSON.parse(String(row.payload))
    payload.sources[0].quote = "被篡改的引文"
    await s.database.transaction(c => c.query("UPDATE equilens_evidence_items SET payload=$1 WHERE version_id=$2", [JSON.stringify(payload), saved.versionId]))
    await assert.rejects(s.repository.item("project-normal", saved.versionId), { code: "EVIDENCE_INTEGRITY_FAILED" })
  } finally { await close(s) }
})
