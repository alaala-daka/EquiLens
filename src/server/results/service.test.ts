import assert from "node:assert/strict"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { statements } from "./schema"
import { ResultRepository } from "./repository"
import { ResultService, type ResultAuthorizer, type SaveResultInput } from "./service"
import { ResultValidatorRegistry } from "./validation"
import type { AuthIdentity } from "../auth/service"
test("immutable revisions, idempotency, review reset, stale and permissions", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => { for (const sql of statements) await c.query(sql) })
    const service = new ResultService(new ResultRepository(db), new ResultValidatorRegistry(new Map([["test", async value => ({ status: value === "bad" ? "invalid" : "valid", issues: [] })]])))
    const identity = { account: { id: "account" } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_, projectId, action) => ({ projectId, action, role: "editor", identity })
    const input: SaveResultInput = { projectId: "p",kind: "test",baseVersionId: "",operationId: "one",reason: "理由",value: "正文",sources: [],dependencies: [] }
    const first = await service.saveResultRevision(identity,authorize,input)
    assert.equal((await service.saveResultRevision(identity,authorize,input)).versionId,first.versionId)
    await assert.rejects(service.saveResultRevision(identity,authorize,{ ...input,value: "更改" }),{ code: "CONFLICT" })
    const approved = await service.reviewResult(identity,authorize,{ ...first,decision: "approved",comment: "同意" })
    assert.equal(approved.review?.decision,"approved")
    const second = await service.saveResultRevision(identity,authorize,{ ...input,resultId: first.resultId,baseVersionId: first.versionId,operationId: "two",value: "bad" })
    assert.equal(second.review,null)
    assert.equal(second.validation.status,"invalid")
    assert.equal((await service.get(identity,authorize,"p",first.resultId,first.versionId)).value,"正文")
    await assert.rejects(service.reviewResult(identity,authorize,{ ...first,decision: "approved",comment: "" }),{ code: "CONFLICT" })
    await assert.rejects(service.reviewResult(identity,authorize,{ ...second,decision: "approved",comment: "" }),{ code: "INVALID_SOURCE" })
    await assert.rejects(service.get(identity,authorize,"other",first.resultId),{ code: "NOT_FOUND" })
    await assert.rejects(service.saveResultRevision(identity,async (_,projectId,action) => ({ projectId,action,role: "viewer",identity }),input),{ code: "FORBIDDEN" })
  } finally { await db.close() }
})

// Source checks are independent of business-validator success.
test("invalid citation cannot be approved and decimal amount text is preserved", async () => {
  const db = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  try {
    await db.transaction(async c => {
      for (const sql of statements) await c.query(sql)
      await c.query("CREATE TABLE equilens_source_fragments(id TEXT, project_id TEXT, snapshot_id TEXT, text TEXT)")
      await c.query("INSERT INTO equilens_source_fragments VALUES('fragment','p','snapshot','原始文字')")
    })
    const service = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["test",async () => ({ status: "valid",issues: [] })]])))
    const identity = { account: { id: "account" } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "editor" })
    const input: SaveResultInput = { projectId: "p",kind: "test",baseVersionId: "",operationId: "quote",reason: "引用",value: { amount: "9007199254740993.01" },sources: [{ fragmentId: "fragment",snapshotId: "snapshot",quote: "伪造" }],dependencies: [] }
    const invalid = await service.saveResultRevision(identity,authorize,input)
    assert.equal(invalid.validation.issues[0].code,"INVALID_SOURCE")
    await assert.rejects(service.reviewResult(identity,authorize,{ ...invalid,decision: "approved",comment: "" }),{ code: "INVALID_SOURCE" })
    for (const [operationId, sources] of [
      ["wrong-snapshot", [{ fragmentId: "fragment",snapshotId: "other",quote: "原始文字" }]],
      ["wrong-project", [{ fragmentId: "foreign",snapshotId: "snapshot",quote: "原始文字" }]],
    ] as const) {
      const rejected = await service.saveResultRevision(identity,authorize,{ ...input,operationId,sources: [...sources] })
      assert.equal(rejected.validation.status,"invalid")
    }
    const valid = await service.saveResultRevision(identity,authorize,{ ...input,resultId: invalid.resultId,baseVersionId: invalid.versionId,operationId: "fixed",sources: [{ fragmentId: "fragment",snapshotId: "snapshot",quote: "原始文字" }] })
    assert.equal(valid.validation.status,"valid")
    assert.deepEqual(valid.sources,[{ fragmentId: "fragment",snapshotId: "snapshot",quote: "原始文字" }])
    assert.deepEqual((await service.get(identity,authorize,"p",invalid.resultId,invalid.versionId)).sources,input.sources)
    assert.deepEqual(valid.value,{ amount: "9007199254740993.01" })
    await assert.rejects(service.saveResultRevision(identity,async () => { throw Object.assign(new Error(),{ code: "FORBIDDEN" }) },input),{ code: "FORBIDDEN" })
  } finally { await db.close() }
})

test("machine attempt token is checked transactionally; generated retries cannot overwrite human revisions", async () => {
  const db = await connectDatabase({ provider: "sqlite",path: ":memory:" })
  try {
    await db.transaction(async c => {
      for (const sql of statements) await c.query(sql)
      await c.query("CREATE TABLE equilens_tasks(id TEXT,project_id TEXT,owner TEXT,attempt INTEGER,execution_token TEXT,state TEXT,lease_until TEXT,updated_at TEXT,manifest TEXT,manifest_hash TEXT)")
      await c.query("INSERT INTO equilens_tasks VALUES('task','p','account',2,'current','running','2099-01-01','now','{\"materials\":[]}','manifest-hash')")
    })
    const service = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["test",async () => ({ status: "valid",issues: [] })]])))
    const identity = { account: { id: "account" } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "editor" })
    const input: SaveResultInput = { projectId: "p",kind: "test",baseVersionId: "",operationId: "machine",reason: "生成",value: "结构化输出",sources: [],dependencies: [{ kind: "rule",id: "rule",versionId: "v1" }] }
    const machine = { output: { raw: "机器原始输出" },taskId: "task",attempt: 2,executionToken: "current" }
    await assert.rejects(service.saveResultRevision(identity,authorize,input,{ ...machine,executionToken: "stale" }),{ code: "CONFLICT" })
    assert.equal((await service.list(identity,authorize,"p")).length,0)
    const first = await service.saveResultRevision(identity,authorize,input,machine)
    const human = await service.saveResultRevision(identity,authorize,{ ...input,resultId: first.resultId,operationId: "human",baseVersionId: first.versionId,value: "人工修订" })
    assert.deepEqual(human.machineOutput,machine.output)
    assert.deepEqual((await service.get(identity,authorize,"p",first.resultId,first.versionId)).dependencies,input.dependencies)
    await db.transaction(async c => { await c.query("UPDATE equilens_tasks SET state='success',attempt=3,execution_token='replacement',manifest='{}'") })
    const reloaded = await service.get(identity,authorize,"p",first.resultId,human.versionId)
    assert.deepEqual(reloaded.provenance,{ taskId: "task",attempt: 2,manifest: { materials: [] },manifestHash: "manifest-hash" })
    assert.equal(human.origin,"human")
    await assert.rejects(service.saveResultRevision(identity,authorize,{ ...input,resultId: first.resultId,baseVersionId: human.versionId,operationId: "retry" },machine),{ code: "CONFLICT" })
    assert.equal((await service.get(identity,authorize,"p",first.resultId)).value,"人工修订")
  } finally { await db.close() }
})
