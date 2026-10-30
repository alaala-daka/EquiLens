import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { strFromU8, unzipSync } from "fflate"
import { connectDatabase } from "../database/connection"
import { statements } from "../results/schema"
import { ResultService, type ResultAuthorizer } from "../results/service"
import { ResultRepository } from "../results/repository"
import { ResultValidatorRegistry } from "../results/validation"
import { createSyntheticObjectStore, createFaultyObjectStore } from "../storage/obs"
import type { AuthIdentity } from "../auth/service"
import { ExportService, ExportTemplateRegistry } from "./service"
import { ExportRepository } from "./repository"

test("selected human revision, frozen state, template upgrade, failure protection and permissions", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => { for (const sql of statements) await c.query(sql) })
    const identity = { account: { id: randomUUID() } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "editor" })
    const viewer: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "viewer" })
    const results = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["test",async value => ({ status: value === "bad" ? "invalid" : "valid",issues: value === "bad" ? [{ code: "MISSING",message: "待补充" }] : [] })]])))
    const input = { projectId: randomUUID(),kind: "test",baseVersionId: "",operationId: "one",reason: "创建",value: "原稿",sources: [],dependencies: [{ kind: "material" as const,id: "m",versionId: "v1" }] }
    const first = await results.saveResultRevision(identity,authorize,input)
    const human = await results.saveResultRevision(identity,authorize,{ ...input,resultId: first.resultId,baseVersionId: first.versionId,operationId: "human",value: "人工正文" })
    const store = createSyntheticObjectStore()
    const templates = new ExportTemplateRegistry(new Map([["test", { version: "v1",paragraphs: value => [String(value)] }]]))
    const retention = async () => "2027-12-31T00:00:00.000Z"
    const exports = new ExportService(new ExportRepository(db),results,store,templates,retention)
    const old = await exports.createExport(identity,authorize,first)
    const saved = await exports.createExport(identity,authorize,human)
    const bytes = await exports.download(identity,viewer,human.projectId,human.resultId,saved.exportId)
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"])
    assert.ok(xml.includes("人工正文")); assert.ok(xml.includes("待复核")); assert.ok(xml.includes("v1"))
    assert.equal((await exports.list(identity,viewer,human.projectId,human.resultId)).length,2)
    await results.reviewResult(identity,authorize,{ ...human,decision: "approved",comment: "通过" })
    assert.deepEqual(await exports.download(identity,viewer,human.projectId,human.resultId,saved.exportId),bytes)
    const upgraded = new ExportService(new ExportRepository(db),results,store,new ExportTemplateRegistry(new Map([["test", { version: "v2",paragraphs: value => [String(value),"新版"] }]])),retention)
    const replacement = await upgraded.createExport(identity,authorize,human)
    assert.equal((await new ExportRepository(db).get(human.projectId,human.resultId,replacement.exportId)).supersedes_id,saved.exportId)
    const failingRepository = new ExportRepository(db)
    failingRepository.createReady = async () => { throw new Error("synthetic ready failure") }
    const interrupted = new ExportService(failingRepository,results,store,templates,retention)
    await assert.rejects(interrupted.createExport(identity,authorize,human))
    const pending = await new ExportRepository(db).pending()
    assert.equal(pending.length,1)
    assert.ok(await store.get(String(pending[0].object_key)))
    await assert.rejects(exports.download(identity,viewer,human.projectId,human.resultId,String(pending[0].id)),{ code: "NOT_FOUND" })
    const recovered = new ExportService(new ExportRepository(db),results,store,templates,retention)
    const failedCleanup = new ExportService(new ExportRepository(db),results,{ ...store,async delete() { throw new Error("cleanup interrupted") } },templates,retention)
    await assert.rejects(failedCleanup.repairPending(Date.parse(String(pending[0].created_at)) + 600_000))
    assert.equal((await new ExportRepository(db).pending()).length,0)
    assert.equal((await new ExportRepository(db).aborted()).length,1)
    await assert.rejects(new ExportRepository(db).createReady(human.projectId,String(pending[0].id)),{ code: "CONFLICT" })
    await recovered.repairPending(Date.parse(String(pending[0].created_at)) + 600_000)
    assert.equal(await store.get(String(pending[0].object_key)),null)
    assert.equal((await new ExportRepository(db).pending()).length,0)
    assert.deepEqual(await exports.download(identity,viewer,human.projectId,human.resultId,saved.exportId),bytes)
    await assert.rejects(new ExportService(new ExportRepository(db),results,store,templates,async () => null).createExport(identity,authorize,human),{ code: "SERVICE_UNAVAILABLE" })
    assert.deepEqual(await upgraded.download(identity,viewer,human.projectId,human.resultId,saved.exportId),bytes)
    assert.ok(strFromU8(unzipSync(await exports.download(identity,viewer,first.projectId,first.resultId,old.exportId))["word/document.xml"]).includes("原稿"))
    await assert.rejects(exports.createExport(identity,viewer,human),{ code: "FORBIDDEN" })
    await assert.rejects(exports.download(identity,authorize,randomUUID(),human.resultId,saved.exportId),{ code: "NOT_FOUND" })
    await assert.rejects(exports.createExport(identity,authorize,{ ...human,sha256: "0".repeat(64) }),{ code: "CONFLICT" })
    const tampered = new ExportService(new ExportRepository(db),results,{ ...store,async get(key) { const object = await store.get(key); return object ? { ...object,bytes: new Uint8Array([0]) } : null } },templates,retention)
    await assert.rejects(tampered.download(identity,viewer,human.projectId,human.resultId,saved.exportId),{ code: "SERVICE_UNAVAILABLE" })
    await assert.rejects(exports.download(identity,async () => { throw Object.assign(new Error(),{ code: "FORBIDDEN" }) },human.projectId,human.resultId,saved.exportId),{ code: "FORBIDDEN" })
    await assert.rejects(new ExportService(new ExportRepository(db),results,store,new ExportTemplateRegistry(),retention).createExport(identity,authorize,human),{ code: "SERVICE_UNAVAILABLE" })
    const failed = new ExportService(new ExportRepository(db),results,createFaultyObjectStore(store,{ put: 1 }),templates,retention)
    await assert.rejects(failed.createExport(identity,authorize,human))
    assert.deepEqual(await exports.download(identity,viewer,human.projectId,human.resultId,saved.exportId),bytes)
    assert.equal((await results.get(identity,authorize,human.projectId,human.resultId)).value,"人工正文")
    const bad = await results.saveResultRevision(identity,authorize,{ ...input,resultId: human.resultId,baseVersionId: human.versionId,operationId: "bad",value: "bad" })
    const draft = await exports.createExport(identity,authorize,bad)
    const draftXml = strFromU8(unzipSync(await exports.download(identity,viewer,bad.projectId,bad.resultId,draft.exportId))["word/document.xml"])
    assert.ok(draftXml.includes("草稿")); assert.ok(draftXml.includes("待补充")); assert.ok(!draftXml.includes("已复核"))
    assert.equal((await exports.queryDependencyChanges(identity,authorize,human,async () => "v2"))[0].status,"changed")
    assert.equal((await exports.queryDependencyChanges(identity,authorize,human,async () => null))[0].status,"unknown")
    assert.equal((await exports.queryDependencyChanges(identity,authorize,human,async () => "v1"))[0].status,"unchanged")
  } finally { await db.close() }
})

test("a template that blocks invalid results still exports valid and partial revisions", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => { for (const sql of statements) await c.query(sql) })
    const identity = { account: { id: randomUUID() } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "editor" })
    const status = (value: unknown) => value === "bad" ? "invalid" : value === "partial" ? "partial" : "valid"
    const results = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["test",async value => ({ status: status(value),issues: value === "bad" ? [{ code: "MISSING",message: "待补充" }] : [] })]])))
    const input = { projectId: randomUUID(),kind: "test",baseVersionId: "",operationId: "strict-1",reason: "创建",value: "bad",sources: [],dependencies: [{ kind: "material" as const,id: "m",versionId: "v1" }] }
    const invalid = await results.saveResultRevision(identity,authorize,input)
    const templates = new ExportTemplateRegistry(new Map([["test", { version: "v1",paragraphs: value => [String(value)],blocksInvalidResult: true }]]))
    const strict = new ExportService(new ExportRepository(db),results,createSyntheticObjectStore(),templates,async () => "2027-12-31T00:00:00.000Z")
    await assert.rejects(strict.createExport(identity,authorize,invalid),{ code: "INVALID_SOURCE" })
    const partial = await results.saveResultRevision(identity,authorize,{ ...input,operationId: "strict-2",value: "partial" })
    assert.equal((await strict.createExport(identity,authorize,partial)).format,"docx")
    const valid = await results.saveResultRevision(identity,authorize,{ ...input,operationId: "strict-3",value: "good" })
    assert.equal((await strict.createExport(identity,authorize,valid)).format,"docx")
  } finally { await db.close() }
})
