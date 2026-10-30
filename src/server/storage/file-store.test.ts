import assert from "node:assert/strict"
import { after, test } from "node:test"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileObjectStore } from "./file-store"
import { objectKey } from "./obs"

const projectId = "11111111-1111-4111-8111-111111111111"
const materialId = "22222222-2222-4222-8222-222222222222"
const versionId = "33333333-3333-4333-8333-333333333333"
const key = objectKey({ projectId, materialId, versionId, sha256: "a".repeat(64) })
const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "equilens-objects-"))
  temporaryRoots.push(root)
  return root
}

function pathFor(root: string, objectKey: string): string {
  return join(root, ...objectKey.split("/"))
}

after(async () => {
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

test("development file store: bytes survive a new store instance and delete removes the object", async () => {
  const root = await temporaryRoot()
  const store = createFileObjectStore(root)
  assert.equal(store.kind, "file")
  const stored = await store.put({ key, bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" })
  assert.equal(stored.size, 3)
  assert.match(stored.sha256, /^[0-9a-f]{64}$/)

  const restarted = createFileObjectStore(root)
  const fetched = (await restarted.get(key))!
  assert.deepEqual([...fetched.bytes], [1, 2, 3])
  assert.equal(fetched.contentType, "application/pdf")
  assert.equal(fetched.sha256, stored.sha256)

  await restarted.delete(key)
  assert.equal(await store.get(key), null)
  await store.delete(key)
  assert.equal("createPublicUrl" in store, false)
  assert.equal("presign" in store, false)
})

test("development file store: same bytes are idempotent while different content conflicts", async () => {
  const root = await temporaryRoot()
  const store = createFileObjectStore(root)
  const first = await store.put({ key, bytes: new Uint8Array([4, 5]), contentType: "application/pdf" })
  assert.deepEqual(await store.put({ key, bytes: new Uint8Array([4, 5]), contentType: "application/pdf" }), first)
  await assert.rejects(store.put({ key, bytes: new Uint8Array([6]), contentType: "application/pdf" }), { code: "CONFLICT" })
  await assert.rejects(store.put({ key, bytes: new Uint8Array([4, 5]), contentType: "text/plain" }), { code: "CONFLICT" })
})

test("development file store: invalid input and keys are rejected before touching disk", async () => {
  const root = await temporaryRoot()
  const store = createFileObjectStore(root)
  await assert.rejects(store.put({ key, bytes: new Uint8Array(), contentType: "application/pdf" }), { code: "INVALID_INPUT" })
  await assert.rejects(store.put({ key, bytes: new Uint8Array([1]), contentType: "" }), { code: "INVALID_INPUT" })
  await assert.rejects(store.get("../escape"), { code: "INVALID_KEY" })
  await assert.rejects(store.delete("projects/x/materials/y/versions/z/" + "a".repeat(64)), { code: "INVALID_KEY" })
  assert.equal(await store.get(key), null)
})

test("development file store: tampered object bytes are rejected instead of returned", async () => {
  const root = await temporaryRoot()
  const store = createFileObjectStore(root)
  await store.put({ key, bytes: new Uint8Array([7, 8, 9]), contentType: "application/pdf" })
  const file = pathFor(root, key)
  await appendFile(file, Buffer.from([0]))
  await assert.rejects(store.get(key), { code: "UNAVAILABLE" })

  await writeFile(file, "not an object header\nbytes")
  await assert.rejects(store.get(key), { code: "UNAVAILABLE" })
})

test("development file store: stored bytes are a private copy, not the caller's array", async () => {
  const root = await temporaryRoot()
  const store = createFileObjectStore(root)
  const bytes = new Uint8Array([1, 2, 3])
  await store.put({ key, bytes, contentType: "application/pdf" })
  bytes[0] = 9
  assert.deepEqual([...(await store.get(key))!.bytes], [1, 2, 3])
  const raw = await readFile(pathFor(root, key), "utf8")
  assert.match(raw, /^\{"version":1,/)
})
