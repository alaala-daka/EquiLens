import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID, createHash } from "node:crypto"
import { connectDatabase } from "../database/connection"
import { BusinessError } from "../projects/errors"
import { createSyntheticObjectStore, documentObjectKey } from "../storage/obs"
import { MaterialRepository } from "./repository"
import { ProjectDocumentRepository } from "./document-repository"
import { documentStatements } from "./document-schema"
import { applyProjectSchema } from "../projects/schema"
import { applyMaterialSchema } from "./schema"
import { ProjectEditorService } from "./editor"
import { createProjectEditorHandlers } from "./editor-http"

test("C3 service: byte-preserving save, retry, stale base, revocation and cross-project reads", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => { for (const sql of documentStatements) await c.query(sql) })
    await applyProjectSchema(db)
    await applyMaterialSchema(db)
    const repository = new ProjectDocumentRepository(db), store = createSyntheticObjectStore()
    const projectId = randomUUID(), documentId = randomUUID(), versionId = randomUUID(), now = new Date().toISOString()
    const bytes = new Uint8Array([1, 2, 3]), hash = createHash("sha256").update(bytes).digest("hex")
    const key = documentObjectKey({ projectId, documentId, versionId, sha256: hash })
    await store.put({ key, bytes, contentType: "application/octet-stream" })
    await repository.create({ id: documentId, projectId, title: "合成合同", currentVersionId: versionId, materialId: randomUUID(), materialVersionId: randomUUID(), copiedFrom: null, createdAt: now, updatedAt: now }, { id: versionId, projectId, documentId, parentId: null, sha256: hash, objectKey: key, size: 3, createdAt: now, operationId: randomUUID(), inputHash: "initial", editorVersion: "test" })
    const identity = { account: { id: randomUUID(), username: "synthetic", role: "member" as const }, session: { id: randomUUID(), expiresAt: Date.now() + 60000 } }
    let revoked = false, readOnly = false
    const service = new ProjectEditorService({ repository, materials: new MaterialRepository(db), store, retentionUntil: async () => "2027-12-31", validate: async () => {}, authorize: async (_identity, projectId, action) => { if (revoked || (readOnly && action !== "read")) throw new BusinessError("FORBIDDEN", "无权访问项目。"); return { projectId, role: readOnly ? "viewer" : "editor", action, identity } } })
    await assert.rejects(service.create(identity, projectId, randomUUID(), randomUUID()), { code: "NOT_FOUND" })
    const input = { baseVersionId: versionId, operationId: randomUUID(), title: "修改合同", editorVersion: "test" }
    const saved = await service.save(identity, projectId, documentId, input, new Uint8Array([4, 5, 6]))
    assert.equal((await service.save(identity, projectId, documentId, input, new Uint8Array([4, 5, 6]))).version.id, saved.version.id)
    assert.deepEqual((await service.content(identity, projectId, documentId, versionId)).bytes, bytes)
    assert.deepEqual((await service.content(identity, projectId, documentId, saved.version.id)).bytes, new Uint8Array([4, 5, 6]))
    await assert.rejects(service.save(identity, projectId, documentId, { ...input, operationId: randomUUID() }, bytes), { code: "CONFLICT" })
    await assert.rejects(service.open(identity, randomUUID(), documentId), { code: "NOT_FOUND" })
    const copyInput = { ...input, operationId: randomUUID(), title: "冲突另存" }
    const copied = await service.copy(identity, projectId, documentId, copyInput, bytes)
    assert.deepEqual(copied.document.copiedFrom, { documentId, versionId })
    assert.equal((await service.copy(identity, projectId, documentId, copyInput, bytes)).document.id, copied.document.id)
    const editedCopy = await service.save(identity, projectId, copied.document.id, { ...input, baseVersionId: copied.version.id, operationId: randomUUID() }, new Uint8Array([7, 8, 9]))
    const retriedCopy = await service.copy(identity, projectId, documentId, copyInput, bytes)
    assert.equal(retriedCopy.version.id, copied.version.id)
    assert.equal((await service.open(identity, projectId, copied.document.id)).version.id, editedCopy.version.id)
    assert.equal((await service.open(identity, projectId, documentId)).version.id, saved.version.id)
    const handlers = createProjectEditorHandlers(async () => ({ requireAccount: async () => identity, origin: () => "https://equilens.test", editor: service }))
    const context = { params: Promise.resolve({ id: projectId, documentId }) }
    const detail = await handlers.open(new Request("https://equilens.test"), context)
    const publicView = await detail.json()
    assert.equal(detail.headers.get("cache-control"), "private, no-store")
    assert.equal(publicView.version.objectKey, undefined)
    assert.equal(publicView.version.inputHash, undefined)
    assert.equal((await handlers.preflight(new Request("https://equilens.test", { method: "POST", headers: { origin: "https://other.test" } }), context)).status, 403)
    assert.equal((await handlers.save(new Request("https://equilens.test", { method: "POST", headers: { origin: "https://equilens.test" }, body: JSON.stringify({ ...input, blob: "not base64" }) }), context)).status, 400)
    const download = await handlers.download(new Request(`https://equilens.test?versionId=${versionId}`), context)
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes)
    // Durable write intents recover both commit-before-complete and put-before-commit.
    const orphanId = randomUUID(), orphanKey = documentObjectKey({ projectId, documentId, versionId: orphanId, sha256: hash })
    await repository.beginWrite({ id: randomUUID(), projectId, objectKey: key, materialId: randomUUID(), materialVersionId: randomUUID(), retentionUntil: "2027-12-31" })
    await repository.beginWrite({ id: orphanId, projectId, objectKey: orphanKey, materialId: randomUUID(), materialVersionId: randomUUID(), retentionUntil: "2027-12-31" })
    await store.put({ key: orphanKey, bytes, contentType: "application/octet-stream" })
    await db.transaction(c => c.query("UPDATE equilens_project_document_writes SET created_at=$1 WHERE state=$2", ["2020-01-01T00:00:00Z", "pending"]))
    const deleteObject = store.delete.bind(store)
    store.delete = async () => { throw new Error("synthetic delete failure") }
    assert.equal(await service.repairWrites(), 1)
    assert.equal((await repository.pendingWrites(new Date().toISOString(), 10)).length, 1)
    store.delete = deleteObject
    assert.equal(await service.repairWrites(), 1)
    assert.equal(await store.get(orphanKey), null)
    assert.notEqual(await store.get(key), null)
    readOnly = true
    assert.equal((await service.open(identity, projectId, documentId)).canEdit, false)
    await assert.rejects(service.save(identity, projectId, documentId, input, bytes), { code: "FORBIDDEN" })
    await assert.rejects(service.copy(identity, projectId, documentId, copyInput, bytes), { code: "FORBIDDEN" })
    revoked = true
    await assert.rejects(service.preflight(identity, projectId, documentId), { code: "FORBIDDEN" })
    await assert.rejects(service.content(identity, projectId, documentId, saved.version.id), { code: "FORBIDDEN" })
    assert.equal((await handlers.preflight(new Request("https://equilens.test", { method: "POST", headers: { origin: "https://equilens.test" } }), context)).status, 403)
  } finally { await db.close() }
})
