import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "@/server/database/connection"
import { PaymentLedgerRepository } from "@/server/payments/repository"
import type { LedgerInput, LedgerRow } from "@/lib/payments/types"

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-ledger-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  const repository = new PaymentLedgerRepository(database)
  await repository.initialize()
  return { directory, database, repository }
}
async function close(value: Awaited<ReturnType<typeof setup>>) { await value.database.close(); await rm(value.directory, { recursive: true }) }
const source = (projectId = "project-a") => ({ projectId, documentId: "doc-1", documentVersionId: "version-1", parseSnapshotId: "snapshot-1", paragraphIndex: 0, quote: "本期净应付80万元" })
function rows(): LedgerRow[] {
  return [
    { rowId: "due", nature: "净应付", amountFen: "80000000", taxBasis: "含税", basis: "本期", periodStart: "2026-10-01", periodEnd: "2026-10-31",
      dueDate: "2026-10-31", conditionMet: true, payer: "甲", payee: "乙", confirmation: "已确认", source: source() },
    { rowId: "paid", nature: "付款", amountFen: "30000000", taxBasis: "含税", basis: "本期", periodStart: "2026-10-01", periodEnd: "2026-10-31",
      eventDate: "2026-10-30", payer: "甲", payee: "乙", confirmation: "已确认", source: source() },
  ]
}
function input(): LedgerInput { return { projectId: "project-a", contractId: "contract-1", cutoff: "2026-10-31", rows: rows(), facts: [], createdBy: "复核人甲", reason: "初始核对" } }

test("AC-06/20: ledger revisions compute 500,000 yuan from confirmed rows and preserve old versions", async () => {
  const s = await setup()
  try {
    const first = await s.repository.save("project-a", input())
    assert.equal(first.calculation?.unpaidFen, "50000000")
    assert.equal(first.calculation?.netDueFen, "80000000")
    const second = await s.repository.save("project-a", { ...input(), ledgerId: first.ledgerId, baseRevisionId: first.ledgerRevisionId,
      rows: [...rows(), { rowId: "extra", nature: "付款", amountFen: "10000000", taxBasis: "含税", basis: "本期", periodStart: "2026-10-01", periodEnd: "2026-10-31",
        eventDate: "2026-10-31", payer: "甲", payee: "乙", confirmation: "已确认", source: source() }], reason: "补充一笔付款" })
    assert.equal(second.version, 2); assert.equal(second.calculation?.unpaidFen, "40000000")
    assert.equal((await s.repository.revision("project-a", first.ledgerRevisionId)).calculation?.unpaidFen, "50000000")
    assert.equal((await s.repository.latest("project-a", first.ledgerId))?.ledgerRevisionId, second.ledgerRevisionId)
  } finally { await close(s) }
})

test("AC-20: duplicate payments dedupe, negative balances remain negative, and stale/foreign/float inputs fail", async () => {
  const s = await setup()
  try {
    const duplicate = await s.repository.save("project-a", { ...input(), rows: [...rows(), { ...rows()[1], rowId: "paid-2" }] })
    assert.equal(duplicate.calculation?.unpaidFen, "50000000")
    assert.ok(duplicate.notes.some(note => note.includes("去重")))
    const negative = await s.repository.save("project-a", { ...input(), rows: [rows()[0], { ...rows()[1], amountFen: "90000000" }] })
    assert.equal(negative.calculation?.unpaidFen, "-10000000")
    await assert.rejects(s.repository.save("project-a", { ...input(), rows: [{ ...rows()[0], amountFen: "100.5" }] }), { code: "LEDGER_AMOUNT_INVALID" })
    await assert.rejects(s.repository.save("project-a", { ...input(), rows: [{ ...rows()[0], source: source("project-b") }] }), { code: "LEDGER_PROJECT_MISMATCH" })
    const first = await s.repository.save("project-a", input())
    await assert.rejects(s.repository.save("project-a", { ...input(), ledgerId: first.ledgerId, baseRevisionId: "stale", rows: rows() }), { code: "LEDGER_BASE_STALE" })
    await assert.rejects(s.repository.revision("project-b", first.ledgerRevisionId), { code: "LEDGER_NOT_FOUND" })
  } finally { await close(s) }
})
