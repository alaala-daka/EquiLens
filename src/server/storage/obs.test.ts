import assert from "node:assert/strict"
import { test } from "node:test"
import {
  assertObjectKey, createFaultyObjectStore, createSyntheticObjectStore, createUnavailableObjectStore, objectKey, ObjectStoreError,
} from "./obs"

const projectId = "11111111-1111-4111-8111-111111111111"
const materialId = "22222222-2222-4222-8222-222222222222"
const versionId = "33333333-3333-4333-8333-333333333333"
const sha = "a".repeat(64)
const key = objectKey({ projectId, materialId, versionId, sha256: sha })

test("C2 storage: private immutable objects, no public URL method and key safety", async () => {
  const store = createSyntheticObjectStore()
  const bytes = new Uint8Array([1, 2, 3])
  const stored = await store.put({ key, bytes, contentType: "application/pdf" })
  assert.match(stored.sha256, /^[0-9a-f]{64}$/)
  assert.equal(stored.size, 3)
  bytes[0] = 9
  const fetched = (await store.get(key))!
  assert.deepEqual([...fetched.bytes], [1, 2, 3])
  fetched.bytes[0] = 7
  assert.deepEqual([...(await store.get(key))!.bytes], [1, 2, 3])
  assert.equal(await store.get(objectKey({ projectId, materialId, versionId, sha256: "b".repeat(64) })), null)
  await assert.rejects(store.put({ key, bytes: new Uint8Array([4]), contentType: "application/pdf" }), { code: "CONFLICT" })
  assert.equal("createPublicUrl" in store, false)
  assert.equal("presign" in store, false)
  await store.delete(key)
  assert.equal(await store.get(key), null)
  await store.delete(key)
  for (const invalid of ["../escape", "/projects/x", key.replace("projects/", "projects/../"), "projects/x/materials/y/versions/z/" + sha]) {
    await assert.rejects(store.get(invalid), { code: "INVALID_KEY" })
  }
})

test("C2 storage: object keys cannot be forged from ids or digests", () => {
  assert.throws(() => objectKey({ projectId: "not-a-uuid", materialId, versionId, sha256: sha }), { code: "INVALID_KEY" })
  assert.throws(() => objectKey({ projectId, materialId: "x", versionId, sha256: sha }), { code: "INVALID_KEY" })
  assert.throws(() => objectKey({ projectId, materialId, versionId, sha256: "z".repeat(64) }), { code: "INVALID_KEY" })
  for (const invalid of ["", "/", "projects/../x", "projects/a/materials/b/versions/c/" + sha, key + "/extra"]) {
    assert.throws(() => assertObjectKey(invalid), ObjectStoreError)
  }
  assert.doesNotThrow(() => assertObjectKey(key))
})

test("C2 storage: fault adapter surfaces failures and recovers for residual recycling", async () => {
  const inner = createSyntheticObjectStore()
  const faulty = createFaultyObjectStore(inner, { put: 1, get: 1, delete: 1 })
  await assert.rejects(faulty.put({ key, bytes: new Uint8Array([1]), contentType: "application/pdf" }), { code: "UNAVAILABLE" })
  await faulty.put({ key, bytes: new Uint8Array([1]), contentType: "application/pdf" })
  await assert.rejects(faulty.get(key), { code: "UNAVAILABLE" })
  assert.deepEqual([...(await faulty.get(key))!.bytes], [1])
  await assert.rejects(faulty.delete(key), { code: "UNAVAILABLE" })
  await faulty.delete(key)
  assert.deepEqual(inner.keys(), [])
})

test("C2 storage: unconfigured OBS adapter fails closed instead of pretending success", async () => {
  const store = createUnavailableObjectStore()
  await assert.rejects(store.put({ key, bytes: new Uint8Array([1]), contentType: "application/pdf" }), { code: "UNAVAILABLE" })
  await assert.rejects(store.get(key), { code: "UNAVAILABLE" })
  await assert.rejects(store.delete(key), { code: "UNAVAILABLE" })
})
