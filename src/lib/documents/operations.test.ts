import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import { blankDocx } from "./docx"
import { createDocumentListStore } from "./list-store"
import { createDocumentOperations, type OperationDependencies } from "./operations"
import { EDITOR_VERSION, type DocumentRecord, type OpenDocument } from "./types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function sample(id: string): Promise<OpenDocument> {
  const blob = blankDocx()
  const at = "2026-10-22T00:00:00Z"
  return {
    document: { id, title: id, source: "authored", prompt: "", createdAt: at, updatedAt: at, currentRevision: `${id}-r1` },
    revision: {
      id: `${id}-r1`, documentId: id, parentId: null, blob,
      hash: createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex"),
      createdAt: at, editorVersion: EDITOR_VERSION, templateVersion: "blank-v1",
    },
  }
}

function listWith(...documents: DocumentRecord[]) {
  return createDocumentListStore(async () => [...documents])
}

function dependencies(list: ReturnType<typeof listWith>, overrides: Partial<OperationDependencies> = {}): OperationDependencies {
  return {
    list, blank: blankDocx, validate: async () => {},
    create: async () => null,
    open: async () => { throw new Error("unexpected open") },
    onOpened: () => {},
    ...overrides,
  }
}

test("UI-05: cancel after submission cannot open a late created document", async () => {
  const first = await sample("first")
  const second = await sample("second")
  const late = deferred<OpenDocument | null>()
  const submitted = deferred<void>()
  const seen: string[] = []
  const list = listWith(second.document)
  await list.refresh()
  const operations = createDocumentOperations(dependencies(list, {
    create: async () => { submitted.resolve(); return late.promise },
    open: async () => second,
    onOpened: value => { seen.push(value.document.id) },
  }))
  const pending = operations.create()
  await submitted.promise
  operations.cancel()
  await operations.open(second.document.id)
  late.resolve(first)
  await pending
  assert.deepEqual(seen, [second.document.id])
  assert.equal(operations.getSnapshot().operation, null)
  assert.equal(list.getSnapshot().documents[0]?.id, second.document.id)
})

test("duplicate create submissions invoke the adapter once", async () => {
  const saved = await sample("saved")
  const pending = deferred<OpenDocument | null>()
  let calls = 0
  const list = listWith()
  await list.refresh()
  const operations = createDocumentOperations(dependencies(list, {
    create: async () => { calls += 1; return pending.promise },
  }))
  const first = operations.create()
  const second = operations.create()
  pending.resolve(saved)
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(operations.getSnapshot().operation, null)
  assert.equal(list.getSnapshot().documents[0]?.id, saved.document.id)
})

test("validation failure never calls the create adapter", async () => {
  let calls = 0
  const list = listWith()
  await list.refresh()
  const operations = createDocumentOperations(dependencies(list, {
    validate: async () => { throw new Error("invalid document") },
    create: async () => { calls += 1; return null },
  }))
  await operations.create()
  assert.equal(calls, 0)
  assert.equal(operations.getSnapshot().error?.message, "invalid document")
  assert.equal(list.getSnapshot().documents.length, 0)
})

test("a null create result is cancellation and does not open a document", async () => {
  let opened = 0
  const list = listWith()
  await list.refresh()
  const operations = createDocumentOperations(dependencies(list, {
    create: async () => null,
    onOpened: () => { opened += 1 },
  }))
  await operations.create()
  assert.equal(opened, 0)
  assert.equal(operations.getSnapshot().operation, null)
  assert.equal(list.getSnapshot().documents.length, 0)
})

test("a cancelled old error cannot replace the new open status", async () => {
  const doc = await sample("current")
  const oldFailure = deferred<OpenDocument | null>()
  const submitted = deferred<void>()
  const list = listWith(doc.document)
  await list.refresh()
  const operations = createDocumentOperations(dependencies(list, {
    create: async () => { submitted.resolve(); return oldFailure.promise },
    open: async () => doc,
  }))
  const old = operations.create()
  await submitted.promise
  operations.cancel()
  const current = operations.open(doc.document.id)
  oldFailure.reject(new Error("late old failure"))
  await Promise.all([old, current])
  assert.equal(operations.getSnapshot().operation, null)
  assert.equal(operations.getSnapshot().error, null)
  assert.equal(list.getSnapshot().documents[0]?.id, doc.document.id)
})

test("refresh after cancelling a submitted create shows the saved document", async () => {
  const saved = await sample("saved-on-server")
  const submitted = deferred<void>()
  let savedOnServer = false
  const list = createDocumentListStore(async () => {
    return savedOnServer ? [saved.document] : []
  })
  await list.refresh()
  const response = deferred<OpenDocument | null>()
  const operations = createDocumentOperations(dependencies(list, {
    create: async () => { submitted.resolve(); return response.promise },
  }))
  const pending = operations.create()
  await submitted.promise
  savedOnServer = true
  operations.cancel()
  response.resolve(null)
  await pending
  await list.refresh()
  assert.equal(list.getSnapshot().documents[0]?.id, saved.document.id)
})
