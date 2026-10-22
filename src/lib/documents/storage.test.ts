import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDocument, DATABASE_NAME, digest, listDocuments, openDocument, RevisionConflict, saveDocument } from "./storage"
import { blankDocx } from "./docx"

function readStore(store: string, id: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, 1)
    opening.onsuccess = () => {
      const db = opening.result
      const transaction = db.transaction(store)
      const request = transaction.objectStore(store).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => db.close()
    }
  })
}

test("WD-05/08: save preserves original bytes and immutable parent revision", async () => {
  const original = blankDocx()
  const initial = await createDocument(original, "原件", "imported", "原件.docx")
  const blob = new Blob(["synthetic serialized bytes"])
  const input = { documentId: initial.document.id, baseRevision: initial.revision.id, operationId: crypto.randomUUID(), title: "人工修改", prompt: "会话输入", blob }
  const saved = await saveDocument(input)
  assert.equal(saved.revision.parentId, initial.revision.id)
  assert.equal((await openDocument(initial.document.id)).document.title, "人工修改")
  assert.equal((await openDocument(initial.document.id)).revision.hash, await digest(blob))
  assert.equal((await readStore("originals", initial.document.id)).hash, await digest(original))
  assert.equal((await readStore("revisions", initial.revision.id)).hash, initial.revision.hash)
  assert.equal((await saveDocument(input)).revision.id, saved.revision.id)
  await assert.rejects(saveDocument({ ...input, title: "different payload" }), RevisionConflict)
})

test("WD-07: competing saves have one winner and never overwrite a newer version", async () => {
  const initial = await createDocument(blankDocx(), "并发", "authored")
  const base = { documentId: initial.document.id, baseRevision: initial.revision.id, prompt: "", blob: blankDocx() }
  const operations = ["甲", "乙"].map(title => ({ ...base, operationId: crypto.randomUUID(), title }))
  const results = await Promise.allSettled(operations.map(saveDocument))
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1)
  assert.equal(results.filter(item => item.status === "rejected" && item.reason instanceof RevisionConflict).length, 1)
  const winner = results.find(item => item.status === "fulfilled")!
  if (winner.status !== "fulfilled") throw new Error("missing winner")
  assert.equal((await openDocument(initial.document.id)).revision.id, winner.value.revision.id)
})

test("WD-05/07: same-name documents and their inputs stay isolated", async () => {
  const first = await createDocument(blankDocx(), "相同名称", "authored")
  const second = await createDocument(blankDocx(), "相同名称", "authored")
  assert.notEqual(first.document.id, second.document.id)
  await saveDocument({ documentId: first.document.id, baseRevision: first.revision.id, operationId: crypto.randomUUID(), title: "修改", prompt: "独立输入", blob: blankDocx() })
  assert.equal((await openDocument(second.document.id)).document.title, "相同名称")
  assert.equal((await openDocument(second.document.id)).document.prompt, "")
  assert.ok((await listDocuments()).some(document => document.id === first.document.id))
})

test("WD-06: a failed write rolls back both revision and document pointer", async () => {
  const initial = await createDocument(blankDocx(), "失败保护", "authored")
  const operationId = crypto.randomUUID()
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "documents") throw new DOMException("Synthetic quota failure", "QuotaExceededError")
    return originalPut.apply(this, args)
  }
  try {
    await assert.rejects(saveDocument({ documentId: initial.document.id, baseRevision: initial.revision.id, operationId, title: "应回滚", prompt: "", blob: blankDocx() }), { name: "QuotaExceededError" })
  } finally { IDBObjectStore.prototype.put = originalPut }
  assert.equal((await openDocument(initial.document.id)).revision.id, initial.revision.id)
  assert.equal(await readStore("revisions", operationId), undefined)
})
