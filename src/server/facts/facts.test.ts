import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "@/server/database/connection"
import { FactRepository } from "@/server/facts/repository"
import type { FactInput } from "@/lib/facts/types"

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-facts-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  const repository = new FactRepository(database)
  await repository.initialize()
  return { directory, database, repository }
}
async function close(value: Awaited<ReturnType<typeof setup>>) { await value.database.close(); await rm(value.directory, { recursive: true }) }
const source = (projectId = "project-a") => ({ projectId, documentId: "doc-1", documentVersionId: "version-1", parseSnapshotId: "snapshot-1", paragraphIndex: 3, quote: "付款比例80%" })
const fact = (projectId = "project-a"): FactInput => ({ projectId, contractId: "contract-1", field: "付款比例", nature: "材料记载",
  originalValue: "80%", selectedValue: "80%", unit: "%", caliber: "含税", sources: [source(projectId)], conflicts: [],
  confirmation: "已确认", support: "材料支持", createdBy: "复核人甲" })

test("AC-06/19: fact versions preserve corrections and keep evidence status independent", async () => {
  const s = await setup()
  try {
    const first = await s.repository.save("project-a", fact())
    const corrected = await s.repository.save("project-a", { ...fact(), selectedValue: "75%", reason: "复核合同变更条款", factId: first.factId })
    assert.equal(first.version, 1); assert.equal(corrected.version, 2); assert.equal(corrected.supersedesVersionId, first.factVersionId)
    assert.equal((await s.repository.version("project-a", first.factVersionId)).selectedValue, "80%")
    assert.equal((await s.repository.latest("project-a", first.factId))?.selectedValue, "75%")
    const conflictSource = { ...source(), paragraphIndex: 4, quote: "另一份记录写付款比例75%" }
    const conflict = await s.repository.save("project-a", { ...fact(), confirmation: "已确认", sources: [source()], conflicts: [conflictSource], support: "材料冲突" })
    assert.equal(conflict.evidenceStatus, "材料冲突")
    assert.equal(conflict.confirmation, "已确认")
  } finally { await close(s) }
})

test("AC-07/19/24: facts reject cross-project sources, duplicate sources, invalid corrections and stale reads", async () => {
  const s = await setup()
  try {
    await assert.rejects(s.repository.save("project-a", { ...fact(), sources: [source("project-b")] }), { code: "FACT_PROJECT_MISMATCH" })
    await assert.rejects(s.repository.save("project-a", { ...fact(), sources: [source(), source()] }), { code: "FACT_SOURCE_DUPLICATE" })
    await assert.rejects(s.repository.save("project-a", { ...fact(), selectedValue: "75%" }), { code: "FACT_REVISION_REASON_REQUIRED" })
    const saved = await s.repository.save("project-a", fact())
    await assert.rejects(s.repository.version("project-b", saved.factVersionId), { code: "FACT_NOT_FOUND" })
    await s.database.transaction(c => c.query("UPDATE equilens_fact_versions SET payload=$1 WHERE id=$2", [JSON.stringify({ ...saved, selectedValue: "99%" }), saved.factVersionId]))
    await assert.rejects(s.repository.version("project-a", saved.factVersionId), { code: "FACT_INTEGRITY_FAILED" })
  } finally { await close(s) }
})
