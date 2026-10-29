import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { createMaterialExecutor } from "./executor"
import { MaterialRepository } from "./repository"
import type { ClaimedTask } from "../tasks/repository"
import type { TaskExecutor } from "../tasks/runner-core"
import type { ParsedMaterial } from "./types"

const bytes = new Uint8Array([1,2,3])
const sha256 = createHash("sha256").update(bytes).digest("hex")
const parsed: ParsedMaterial = { format: "pdf", parser: "fixture", parserVersion: "1", coverage: { status: "partial", findings: [], pageCount: 1, textLength: 0 }, text: "", fragments: [] }
const job = { id: "task", projectId: "project", token: "token", attempt: 1, kind: "material-parse", manifest: { refs: { materials: [{ materialVersionId: "version", sha256 }] } } } as unknown as ClaimedTask
const context = (): Parameters<TaskExecutor>[1] => ({ signal: new AbortController().signal, refreshAccess: async () => {}, heartbeat: async () => {}, reserveCall: async () => {}, settleCall: async () => {} })
function fixture(options: { now?: () => Date; projectUntil?: string; parse?: () => Promise<ParsedMaterial> } = {}) {
  let reads = 0, writes = 0
  const repository = {
    versionById: async () => ({ id: "version", materialId: "material", sha256, size: 3, objectKey: "private" }),
    findMaterial: async () => ({ id: "material", status: "active", processingAuthorized: true, retentionUntil: "2099-12-31", format: "pdf", latestRevision: 0 }),
    addSnapshot: async (...args: unknown[]) => { assert.equal(args[3], job); writes++ },
  } as unknown as MaterialRepository
  const executor = createMaterialExecutor({ repository, now: options.now, readProjectRetention: async () => options.projectUntil ?? "2099-12-31", store: { get: async () => { reads++; return { bytes, key: "private", size: 3, sha256, contentType: "application/pdf" } }, put: async () => { throw Error() }, delete: async () => {} }, parse: options.parse ?? (async () => parsed) })
  return { executor, counts: () => ({ reads, writes }) }
}
test("C2b partial coverage is persisted with claimed attempt", async () => {
  const f = fixture()
  assert.equal((await f.executor(job, context())).outcome, "partial")
  assert.deepEqual(f.counts(), { reads: 1, writes: 1 })
})
test("C2b revoked access prevents private object read", async () => {
  const f = fixture(), ctx = context()
  ctx.refreshAccess = async () => { throw Error("revoked") }
  await assert.rejects(f.executor(job, ctx), /revoked/)
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 })
})
test("C2b hash mismatch prevents private object read and snapshot", async () => {
  const f = fixture()
  await assert.rejects(f.executor({ ...job, manifest: { ...job.manifest, refs: { materials: [{ materialVersionId: "version", sha256: "bad" }] } } }, context()), /INVALID_SOURCE/)
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 })
})

test("C2b stale token and expired lease roll back snapshot before material writes", async () => {
  const { connectDatabase } = await import("../database/connection")
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => {
      await c.query("CREATE TABLE equilens_tasks(id TEXT, project_id TEXT, state TEXT, execution_token TEXT, attempt INTEGER, lease_until TEXT, stage TEXT)")
      await c.query("INSERT INTO equilens_tasks VALUES('task','project','running','current',1,'2099-01-01','claimed')")
    })
    const repository = new MaterialRepository(db)
    const snapshot = { id: "snapshot", projectId: "project", materialId: "material", versionId: "version", revision: 1, parser: "fixture", parserVersion: "1", coverage: parsed.coverage, createdAt: new Date().toISOString() }
    await assert.rejects(repository.addSnapshot(snapshot, [], 0, job), { code: "CONFLICT" })
    await db.transaction(c => c.query("UPDATE equilens_tasks SET execution_token='token',lease_until='2000-01-01'"))
    await assert.rejects(repository.addSnapshot(snapshot, [], 0, job), { code: "CONFLICT" })
    await db.transaction(c => c.query("UPDATE equilens_tasks SET lease_until='2099-01-01',attempt=2"))
    await assert.rejects(repository.addSnapshot(snapshot, [], 0, job), { code: "CONFLICT" })
  } finally { await db.close() }
})

test("C2b SQLite queued upload to claimed task to immutable parsed sources", async () => {
  const { connectDatabase } = await import("../database/connection")
  const { applyMaterialSchema, uploadIntentStatements } = await import("./schema")
  const { statements } = await import("../tasks/schema")
  const { TaskRepository } = await import("../tasks/repository")
  const { QueuedMaterialService } = await import("./queued")
  const { createSyntheticObjectStore } = await import("../storage/obs")
  const { randomUUID } = await import("node:crypto")
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await applyMaterialSchema(db)
    await db.transaction(async c => { for (const sql of [...uploadIntentStatements, ...statements]) await c.query(sql) })
    const repository = new MaterialRepository(db), tasks = new TaskRepository(db), store = createSyntheticObjectStore()
    const projectId = randomUUID(), owner = randomUUID()
    await db.transaction(async c => { await c.query("CREATE TABLE equilens_projects(id TEXT PRIMARY KEY)"); await c.query("INSERT INTO equilens_projects VALUES($1)", [projectId]) })
    let checks = 0
    const authorize = async () => { checks++; return {} as never }
    const service = new QueuedMaterialService({ repository, store, requireProjectAccess: authorize, readProject: async () => ({ retentionUntil: "2099-12-31" }), available: () => true, preflight: async () => {}, enqueue: async (_, v, operation) => (await tasks.submit(owner, operation, { kind: "material-parse", projectId, refs: { materials: [{ materialVersionId: v.id, sha256: v.sha256 }] }, conditions: {} })).task.id })
    const text = "BT (Synthetic contract amount) Tj ET"
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", `<< /Length ${text.length + 2} >>\nstream\n${text}\nendstream`]
    const bytes = Buffer.from("%PDF-1.4\n" + objects.map((body, i) => `${i+1} 0 obj\n${body}\nendobj\n`).join("") + "trailer\n<< /Root 1 0 R >>\n%%EOF\n")
    await service.upload({ account: { id: owner } } as never, projectId, { title: "合成材料", fileName: "fixture.pdf", sourceKind: "synthetic", sourceReference: "合成测试", processingAuthorized: true, purpose: "合同审查", retentionUntil: "2099-01-01" }, bytes)
    const claimed = await tasks.claimNext()
    assert.ok(claimed)
    const ctx = context(); ctx.refreshAccess = async () => { await authorize() }
    const result = await createMaterialExecutor({ repository, store, readProjectRetention: async () => "2099-12-31" })(claimed, ctx)
    assert.notEqual(result.outcome, "failed")
    await tasks.finish(claimed, { state: result.outcome, resultSummary: result.resultSummary })
    const snapshots = JSON.parse(result.resultSummary!) as string[]
    const snapshot = await repository.findSnapshot(projectId, snapshots[0])
    assert.ok(snapshot)
    assert.ok((await repository.fragments(snapshot.id)).some(f => f.text.includes("Synthetic contract")))
    assert.ok(checks >= 6)
    assert.equal((await tasks.get(owner, claimed.id)).state, result.outcome)
  } finally { await db.close() }
})




for (const projectUntil of ["2026-10-28", "2099-12-31"]) {
  test(`C2b expired ${projectUntil === "2026-10-28" ? "project" : "material"} prevents queued material read`, async () => {
    const f = fixture({ projectUntil, now: () => new Date(projectUntil === "2026-10-28" ? "2026-10-29" : "2100-01-01") })
    await assert.rejects(f.executor(job, context()), { code: "RETENTION_EXPIRED" })
    assert.deepEqual(f.counts(), { reads: 0, writes: 0 })
  })
}
test("C2b retention expiration during parsing prevents snapshot publication", async () => {
  let current = new Date("2026-10-29T23:59:59Z")
  const f = fixture({ projectUntil: "2026-10-29", now: () => current, parse: async () => { current = new Date("2026-10-30T00:00:00Z"); return parsed } })
  await assert.rejects(f.executor(job, context()), { code: "RETENTION_EXPIRED" })
  assert.deepEqual(f.counts(), { reads: 1, writes: 0 })
})
