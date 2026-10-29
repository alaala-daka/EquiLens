import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { createSyntheticObjectStore, objectKey, createFaultyObjectStore, documentObjectKey, exportObjectKey, assertObjectKey } from "../storage/obs"
import { UploadIntents } from "./upload-intents"
import { applyMaterialSchema, uploadIntentStatements } from "./schema"

const id = "11111111-1111-4111-8111-111111111111"
const key = objectKey({ projectId: id, materialId: id, versionId: id, sha256: "a".repeat(64) })
const authorization = { sourceKind: "synthetic" as const, sourceReference: "合成授权样本", processingAuthorized: true as const, purpose: "合同审查", retentionUntil: "2027-01-01" }

test("C2c/AC-25: persist before put; recover orphan and protect committed object; repair enqueue idempotently", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await applyMaterialSchema(database)
    await database.transaction(async c => { for (const sql of uploadIntentStatements) await c.query(sql) })
    let now = 0
    const intents = new UploadIntents(database, () => new Date(now))
    const store = createSyntheticObjectStore()
    const input = { projectId: id, materialId: id, versionId: id, objectKey: key, accountId: id, ...authorization }
    const intent = await intents.begin(input)
    assert.equal((await intents.open(10))[0].state, "pending")
    await store.put({ key, bytes: new Uint8Array([1]), contentType: "text/plain" })
    await intents.stored(intent.id)
    now = 600001
    let committed = true
    let calls = 0
    const deps = { store, isReferenced: async () => committed, enqueueParse: async () => { calls++; return id } }
    await intents.repair(deps)
    assert.ok(await store.get(key))
    assert.equal(calls, 1)
    await intents.repair(deps)
    assert.equal(calls, 1)
    const orphan = await intents.begin({ ...input, versionId: "22222222-2222-4222-8222-222222222222", objectKey: key.replace(`/versions/${id}/`, "/versions/22222222-2222-4222-8222-222222222222/") })
    await store.put({ key: orphan.objectKey, bytes: new Uint8Array([2]), contentType: "text/plain" })
    committed = false
    now += 600001
    await intents.repair(deps)
    assert.equal(await store.get(orphan.objectKey), null)
    assert.ok(await store.get(key))
  } finally { await database.close() }
})

test("C2c: cleanup failure persists attempts; expiry protects active upload; retries reuse intent", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await applyMaterialSchema(database)
    await database.transaction(async c => { for (const sql of uploadIntentStatements) await c.query(sql) })
    let now = 0
    const intents = new UploadIntents(database, () => new Date(now))
    const store = createSyntheticObjectStore()
    const input = { projectId: id, materialId: id, versionId: id, objectKey: key, accountId: id, ...authorization }
    const intent = await intents.begin(input)
    assert.equal((await intents.begin(input)).id, intent.id)
    await store.put({ key, bytes: new Uint8Array([1]), contentType: "text/plain" })
    const deps = { store: createFaultyObjectStore(store, { delete: 1 }), isReferenced: async () => false }
    await intents.repair(deps)
    assert.ok(await store.get(key))
    now = 600001
    assert.equal((await intents.repair(deps)).remaining, 1)
    assert.equal((await intents.open(10))[0].attempts, 1)
    now += 600001
    assert.equal((await intents.repair(deps)).resolved, 1)
    assert.equal(await store.get(key), null)
  } finally { await database.close() }
})

test("C2c/AC-25: authorization survives crash after put; retention expiry precedes orphan grace", async () => {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await applyMaterialSchema(database)
    await database.transaction(async c => { for (const sql of uploadIntentStatements) await c.query(sql) })
    let now = Date.parse("2026-12-31T23:59:59Z")
    const intents = new UploadIntents(database, () => new Date(now))
    const input = { projectId: id, materialId: id, versionId: id, objectKey: key, accountId: id, ...authorization, retentionUntil: "2026-12-31" }
    await intents.begin(input)
    const persisted = (await intents.open(1))[0]
    for (const field of ["sourceKind", "sourceReference", "processingAuthorized", "purpose", "retentionUntil"] as const) assert.equal(persisted[field], input[field])
    await assert.rejects(intents.begin({ ...input, purpose: "不同目的" }))
    const store = createSyntheticObjectStore()
    await store.put({ key, bytes: new Uint8Array([1]), contentType: "text/plain" })
    // Simulate process loss before stored(): recovery has only the durable pending record.
    now += 2000
    const recovered = new UploadIntents(database, () => new Date(now))
    await recovered.repair({ store, isReferenced: async () => false })
    assert.equal(await store.get(key), null)
  } finally { await database.close() }
})

test("C2c: material/document/export namespaces validate exact identities", () => {
  assertObjectKey(documentObjectKey({ projectId: id, documentId: id, versionId: id, sha256: "a".repeat(64) }))
  assertObjectKey(exportObjectKey({ projectId: id, exportId: id, sha256: "a".repeat(64) }))
  for (const invalid of [key.replace("materials", "exports"), key.replace("versions", "exports"), key.replace(id, "../escape"), key + "/extra"]) assert.throws(() => assertObjectKey(invalid))
})
