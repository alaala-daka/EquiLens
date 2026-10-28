import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "@/server/database/connection"
import { FactRepository } from "@/server/facts/repository"
import { PaymentLedgerRepository } from "@/server/payments/repository"
import { projectDocumentAnalysis } from "@/server/document-agent/projection"
import { paymentExtraction, evidenceExtraction } from "@/server/document-agent/test-fixtures"
import type { DocumentAnalysis } from "@/lib/document-agent/types"

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-projection-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  const facts = new FactRepository(database), ledgers = new PaymentLedgerRepository(database)
  await facts.initialize(); await ledgers.initialize()
  return { directory, database, facts, ledgers }
}
async function close(value: Awaited<ReturnType<typeof setup>>) { await value.database.close(); await rm(value.directory, { recursive: true }) }
const document = { documentId: "doc-1", documentVersionId: "version-1", parseSnapshotId: "snapshot-1" }
function analysis(task: DocumentAnalysis["task"], extraction: DocumentAnalysis["extraction"]): DocumentAnalysis {
  const ids = [...(extraction?.amounts ?? []).map((_, index) => "amount:" + index), ...(extraction?.events ?? []).map((_, index) => "event:" + index)]
  return { version: "document-agent-v1", task, cutoff: "2026-10-31", skill: { id: task, version: "test", sha256: "x" }, extraction, rejected: [],
    audit: { complete: true, checks: ids.map(id => ({ id, accepted: true, reason: "合成核对。" })), gaps: [] },
    calculation: null, calculationNotes: [], reviewStatus: "待人工复核" }
}

test("AC-06/20: payment analysis projects facts and a ledger revision with exact 500,000 yuan", async () => {
  const s = await setup()
  try {
    const result = await projectDocumentAnalysis({ projectId: "project-a", analysis: analysis("payment-reconciliation", paymentExtraction()),
      document, taskId: "task-a", createdBy: "synthetic", facts: s.facts, ledgers: s.ledgers })
    assert.equal(result.factVersionIds.length, 2)
    assert.ok(result.ledgerRevisionId)
    const ledger = await s.ledgers.revision("project-a", result.ledgerRevisionId!)
    assert.equal(ledger.calculation?.unpaidFen, "50000000")
    assert.equal(ledger.facts.length, 2)
    assert.equal(ledger.rows.every(row => (row.factVersionIds?.length ?? 0) === 1), true)
  } finally { await close(s) }
})

test("AC-07/08: evidence events project as facts without creating a payment ledger", async () => {
  const s = await setup()
  try {
    const result = await projectDocumentAnalysis({ projectId: "project-a", analysis: analysis("evidence-organization", evidenceExtraction()),
      document, taskId: "task-b", createdBy: "synthetic", facts: s.facts, ledgers: s.ledgers })
    assert.equal(result.factVersionIds.length, 1)
    assert.equal(result.ledgerRevisionId, undefined)
    const facts = await s.facts.listLatest("project-a")
    assert.equal(facts.length, 1)
    assert.equal(facts[0].field, "证据事件：材料记载收取工程款")
  } finally { await close(s) }
})
