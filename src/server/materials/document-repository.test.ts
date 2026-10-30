import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { connectDatabase } from "../database/connection"
import { documentStatements } from "./document-schema"
import { ProjectDocumentRepository, type ProjectDocument, type ProjectDocumentVersion } from "./document-repository"

test("C3 immutable revisions: CAS conflicts and operation retries preserve selected versions and project isolation", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => { for (const sql of documentStatements) await c.query(sql) })
    const repository = new ProjectDocumentRepository(db)
    const projectId = randomUUID(), id = randomUUID(), initial = randomUUID()
    const document: ProjectDocument = { id, projectId, title: "合成合同", currentVersionId: initial, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), materialId: randomUUID(), materialVersionId: randomUUID(), copiedFrom: null }
    const version: ProjectDocumentVersion = { id: initial, projectId, documentId: id, parentId: null, sha256: "a".repeat(64), objectKey: "private-original", size: 10, createdAt: document.createdAt, operationId: randomUUID(), inputHash: "initial", editorVersion: "import" }
    await repository.create(document, version)
    assert.equal(await repository.find(randomUUID(), id), null)
    const next = { ...version, id: randomUUID(), parentId: initial, operationId: randomUUID(), inputHash: "save" }
    await repository.save({ ...document, currentVersionId: next.id }, next, initial)
    await repository.save({ ...document, currentVersionId: next.id }, next, initial)
    assert.equal((await repository.version(projectId, id, initial))?.sha256, version.sha256)
    assert.equal((await repository.find(projectId, id))?.currentVersionId, next.id)
    await assert.rejects(repository.save(document, { ...next, id: randomUUID(), operationId: randomUUID() }, initial), { code: "CONFLICT" })
    await assert.rejects(repository.save(document, { ...next, inputHash: "changed" }, initial), { code: "CONFLICT" })
    assert.equal(await repository.version(randomUUID(), id, initial), null)
  } finally { await db.close() }
})
