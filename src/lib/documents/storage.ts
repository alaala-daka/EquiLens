import { DOCX_TYPE, EDITOR_VERSION, documentTitle, type DocumentRecord, type OpenDocument, type Revision } from "./types"

export const DATABASE_NAME = "equilens-documents"

export class RevisionConflict extends Error {
  constructor() { super("文档已在其他页面保存。请将当前编辑另存为新文档。") }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function completed(transaction: IDBTransaction) {
  const outcome = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("保存事务已取消，请重试。"))
    transaction.onerror = () => { /* onabort owns the transaction failure. */ }
  })
  // A request can reject before the caller reaches the transaction completion.
  void outcome.catch(() => {})
  return outcome
}

async function transact<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => T | Promise<T>): Promise<T> {
  const transaction = db.transaction(stores, mode)
  const done = completed(transaction)
  try {
    const result = await work(transaction)
    await done
    return result
  } catch (failure) {
    // Synchronous write errors do not automatically roll back prior requests.
    try { transaction.abort() } catch { /* Already completed or aborted. */ }
    await done.catch(() => {})
    throw failure
  }
}

async function database() {
  if (!globalThis.indexedDB) throw new Error("浏览器无法使用文档存储，请检查浏览器设置。")
  const opening = indexedDB.open(DATABASE_NAME, 1)
  opening.onupgradeneeded = () => {
    const db = opening.result
    db.createObjectStore("documents", { keyPath: "id" })
    db.createObjectStore("revisions", { keyPath: "id" })
    db.createObjectStore("originals", { keyPath: "documentId" })
  }
  return request(opening)
}

export async function digest(blob: Blob) {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const db = await database()
  try {
    const values = await transact(db, ["documents"], "readonly", transaction => request<DocumentRecord[]>(transaction.objectStore("documents").getAll()))
    return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } finally { db.close() }
}

export async function openDocument(id: string): Promise<OpenDocument> {
  const db = await database()
  try {
    const { document, revision } = await transact(db, ["documents", "revisions"], "readonly", async transaction => {
      const document = await request<DocumentRecord | undefined>(transaction.objectStore("documents").get(id))
      const revision = document && await request<Revision | undefined>(transaction.objectStore("revisions").get(document.currentRevision))
      return { document, revision }
    })
    if (!document || !revision) throw new Error("找不到文档保存版本。")
    if (await digest(revision.blob) !== revision.hash) throw new Error("文档保存版本校验失败。")
    return { document, revision }
  } finally { db.close() }
}

export async function createDocument(blob: Blob, title: string, source: DocumentRecord["source"], fileName?: string, prompt = "", copiedFrom?: DocumentRecord["copiedFrom"]): Promise<OpenDocument> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const revision: Revision = {
    id: crypto.randomUUID(), documentId: id, parentId: null, blob: new Blob([blob], { type: DOCX_TYPE }),
    hash: await digest(blob), createdAt: now, editorVersion: EDITOR_VERSION, templateVersion: source === "authored" ? "blank-v1" : null,
  }
  const document: DocumentRecord = { id, title: documentTitle(title), source, copiedFrom, prompt, createdAt: now, updatedAt: now, currentRevision: revision.id }
  const db = await database()
  try {
    await transact(db, ["documents", "revisions", "originals"], "readwrite", transaction => {
      transaction.objectStore("documents").add(document)
      transaction.objectStore("revisions").add(revision)
      if (source === "imported") transaction.objectStore("originals").add({ documentId: id, fileName, blob, hash: revision.hash })
    })
    return { document, revision }
  } finally { db.close() }
}

export async function saveDocument(input: {
  documentId: string; baseRevision: string; operationId: string; title: string; prompt: string; blob: Blob
}): Promise<OpenDocument> {
  const hash = await digest(input.blob)
  const db = await database()
  try {
    return await transact(db, ["documents", "revisions"], "readwrite", async transaction => {
      const documents = transaction.objectStore("documents")
      const revisions = transaction.objectStore("revisions")
      const document = await request<DocumentRecord | undefined>(documents.get(input.documentId))
      const prior = await request<Revision | undefined>(revisions.get(input.operationId))
      // Operation IDs are scoped to the document, base version and payload.
      if (prior && document && prior.documentId === input.documentId && prior.parentId === input.baseRevision && prior.hash === hash && document.currentRevision === prior.id && document.title === documentTitle(input.title) && document.prompt === input.prompt) {
        return { document, revision: prior }
      }
      if (!document || document.currentRevision !== input.baseRevision || prior) throw new RevisionConflict()
      const now = new Date().toISOString()
      const revision: Revision = {
        id: input.operationId, documentId: document.id, parentId: input.baseRevision, blob: input.blob,
        hash, createdAt: now, editorVersion: EDITOR_VERSION, templateVersion: null,
      }
      const updated = { ...document, title: documentTitle(input.title), prompt: input.prompt, currentRevision: revision.id, updatedAt: now }
      revisions.add(revision)
      documents.put(updated)
      return { document: updated, revision }
    })
  } finally { db.close() }
}
