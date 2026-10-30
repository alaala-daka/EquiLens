import assert from "node:assert/strict"
import { test } from "node:test"
import { QueuedMaterialService } from "./queued"
import { BusinessError } from "../projects/errors"
import { createHash } from "node:crypto"

test("C2a: unavailable parser rejects before private object storage", async () => {
  let writes = 0
  const service = new QueuedMaterialService({
    repository: {} as never, store: { put: async () => { writes++; throw new Error() }, get: async () => null, delete: async () => {} },
    requireProjectAccess: async () => ({}) as never, readProject: async () => ({ retentionUntil: "2027-12-31" }),
    available: () => false, ocrAvailable: () => false, preflight: async () => { throw new Error("must not run") }, enqueue: async () => "task",
  })
  await assert.rejects(service.upload({ account: { id: "synthetic" } } as never, "11111111-1111-4111-8111-111111111111", {}, new Uint8Array([1])), (error: unknown) => error instanceof BusinessError && error.code === "SERVICE_UNAVAILABLE")
  assert.equal(writes, 0)
})

test("C2a: one hanging store does not retain admission of other successful requests", async () => {
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  let started!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const repository = { findByDigest: async () => null, uploadIntents: () => ({ begin: async () => ({ id: "intent" }), stored: async () => {}, committed: async () => {} }), create: async () => {}, linkTask: async () => {} }
  const service = new QueuedMaterialService({ repository: repository as never,
    store: { put: async input => { if (input.bytes[4] === 1) { started(); await hold } return { key: input.key, sha256: createHash("sha256").update(input.bytes).digest("hex"), size: input.bytes.length } }, get: async () => null, delete: async () => {} },
    requireProjectAccess: async () => ({}) as never, readProject: async () => ({ retentionUntil: "2027-12-31" }),
    available: () => true, ocrAvailable: () => false, preflight: async () => {}, enqueue: async () => "task", now: () => new Date("2026-10-29"),
  })
  const identity = { account: { id: "store-isolation" } } as never
  const body = { title: "合成材料", fileName: "test.docx", sourceKind: "synthetic", sourceReference: "合成授权", processingAuthorized: true, purpose: "合同审查", retentionUntil: "2027-01-01" }
  const projectId = "11111111-1111-4111-8111-111111111111"
  const hung = service.upload(identity, projectId, body, new Uint8Array([80,75,3,4,1]))
  await reached
  try {
    for (let i = 2; i < 12; i++) await service.upload(identity, projectId, body, new Uint8Array([80,75,3,4,i]))
  } finally { finish(); await hung }
})

test("C2a: blocked requests have bounded admission and no waiting queue", async () => {
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const service = new QueuedMaterialService({
    repository: {} as never, store: {} as never,
    requireProjectAccess: async () => { await blocked; throw new BusinessError("FORBIDDEN", "无权访问该项目。") },
    readProject: async () => null, available: () => true, ocrAvailable: () => false, preflight: async () => {}, enqueue: async () => "task",
  })
  const identity = { account: { id: "bounded-test" } } as never
  const admitted = Array.from({ length: 4 }, (_, i) => service.upload(identity, `project-${i}`, {}, new Uint8Array([i + 1])).catch(error => error))
  for (let i = 0; i < 20; i++) await assert.rejects(service.upload(identity, `overflow-${i}`, {}, new Uint8Array([1])), { code: "SERVICE_UNAVAILABLE" })
  unblock()
  await Promise.all(admitted)
})
