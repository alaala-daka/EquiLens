import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { AuthError } from "../auth/errors"
import { BusinessError } from "../projects/errors"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { ResultRepository } from "./repository"
import { ResultService, type ResultAuthorizer } from "./service"
import { ResultValidatorRegistry } from "./validation"
import { statements } from "./schema"
import { resultHandler } from "./http"

test("result HTTP enforces private scope, authorization, strict writes and safe failures", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = "https://equilens.invalid"
  const db = await connectDatabase({ provider: "sqlite",path: ":memory:" })
  try {
    await db.transaction(async c => {
      for (const sql of statements) await c.query(sql)
      await c.query("CREATE TABLE equilens_source_fragments(id TEXT,project_id TEXT,snapshot_id TEXT,text TEXT)")
    })
    const identity = { account: { id: "account" } } as AuthIdentity
    let role: "editor" | "viewer" = "editor", revoked = false
    let failure: Error | undefined
    const authorize: ResultAuthorizer = async (_,projectId,action) => {
      if (revoked || projectId !== "p") throw new BusinessError("FORBIDDEN","无权访问该项目。")
      return { projectId,action,identity,role }
    }
    const service = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["test",async () => ({ status: "valid",issues: [] })]])))
    const services = async () => ({ identity: async () => { if (failure) throw failure; return identity },authorize,service })
    const invoke = (operation: Parameters<typeof resultHandler>[1], input?: unknown, opts: { project?: string; resultId?: string; origin?: string; raw?: string; type?: string } = {}) => resultHandler(services,operation)(new NextRequest("https://equilens.invalid/api/results",{ method: input === undefined && opts.raw === undefined ? "GET" : "POST",headers: { origin: opts.origin ?? "https://equilens.invalid","content-type": opts.type ?? "application/json" },...(input === undefined && opts.raw === undefined ? {} : { body: opts.raw ?? JSON.stringify(input) }) }),{ params: Promise.resolve({ id: opts.project ?? "p",resultId: opts.resultId }) })
    const input = { kind: "test",baseVersionId: "",operationId: "one",reason: "保存",value: "文本",sources: [],dependencies: [] }
    const response = await invoke("save",input)
    assert.equal(response.status,200)
    assert.equal(response.headers.get("cache-control"),"private, no-store")
    const result = await response.json()
    for (const extra of [{ unknown: "field" },{ provenance: {} },{ projectId: "other" },{ origin: "machine" },{ machineOutput: {} },{ serverOwned: true }]) assert.equal((await invoke("save",{ ...input,...extra })).status,400)
    assert.equal((await invoke("save",{ ...input,resultId: "other" },{ resultId: result.resultId })).status,400)
    assert.equal((await invoke("save",input,{ origin: "https://foreign.example" })).status,403)
    assert.equal((await invoke("save",undefined,{ raw: "{" })).status,400)
    assert.equal((await invoke("save",[],{})).status,400)
    assert.equal((await invoke("save",{})).status,400)
    assert.equal((await invoke("save",undefined,{ raw: "x".repeat(262145) })).status,429)
    assert.equal((await invoke("save",input,{ type: "text/plain" })).status,400)
    role = "viewer"
    assert.equal((await invoke("save",input)).status,403)
    assert.equal((await invoke("review",{ versionId: result.versionId,sha256: result.sha256,decision: "approved",comment: "" },{ resultId: result.resultId })).status,403)
    assert.equal((await invoke("get",undefined,{ resultId: result.resultId })).status,200)
    role = "editor"; revoked = true
    assert.equal((await invoke("get",undefined,{ resultId: result.resultId })).status,403)
    revoked = false
    assert.equal((await invoke("get",undefined,{ project: "other",resultId: result.resultId })).status,403)
    const invalidResponse = await invoke("save",{ ...input,operationId: "invalid",sources: [{ fragmentId: "missing",snapshotId: "missing",quote: "伪造" }] })
    const invalid = await invalidResponse.json()
    assert.equal((await invoke("review",{ versionId: invalid.versionId,sha256: invalid.sha256,decision: "approved",comment: "" },{ resultId: invalid.resultId })).status,422)
    for (const [code,status] of [["UNAUTHENTICATED",401],["AUTH_BUSY",503],["AUTH_UNAVAILABLE",503],["FORBIDDEN",403]] as const) {
      failure = new AuthError(code,"private detail")
      const rejected = await invoke("list")
      assert.equal(rejected.status,status)
      assert.equal(rejected.headers.get("cache-control"),"private, no-store")
      assert.ok(!(await rejected.text()).includes("private detail"))
    }
    failure = new Error("SQL credentials")
    const unavailable = await invoke("list")
    assert.equal(unavailable.status,503)
    assert.ok(!(await unavailable.text()).includes("SQL credentials"))
  } finally {
    await db.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("R7: contract-review HTTP bypasses are refused and only finding decisions may change", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = "https://equilens.invalid"
  const db = await connectDatabase({ provider: "sqlite",path: ":memory:" })
  try {
    await db.transaction(async c => {
      for (const sql of statements) await c.query(sql)
      await c.query("CREATE TABLE equilens_source_fragments(id TEXT,project_id TEXT,snapshot_id TEXT,text TEXT)")
      // Machine saves assert their running attempt/lease and copy the task manifest as provenance.
      await c.query("CREATE TABLE equilens_tasks(id TEXT PRIMARY KEY,owner TEXT,project_id TEXT,attempt INTEGER,execution_token TEXT,state TEXT,lease_until TEXT,updated_at TEXT,manifest TEXT,manifest_hash TEXT)")
      await c.query("INSERT INTO equilens_tasks VALUES ('task-1','account','p',1,'token-1','running','2999-01-01T00:00:00.000Z','2026-10-30T00:00:00.000Z','{\"materials\":[]}','manifest-hash')")
    })
    const identity = { account: { id: "account" } } as AuthIdentity
    const authorize: ResultAuthorizer = async (_,projectId,action) => ({ projectId,action,identity,role: "editor" })
    // Round-seven production policy: human writes need an existing machine result.
    const service = new ResultService(new ResultRepository(db),new ResultValidatorRegistry(new Map([["contract-review",async () => ({ status: "valid",issues: [] })]])),new Set(),new Set(),new Set(["contract-review"]),new Set())
    const services = async () => ({ identity: async () => identity,authorize,service })
    const invoke = (input: unknown, resultId?: string) => resultHandler(services,"save")(new NextRequest("https://equilens.invalid/api/results",{ method: "POST",headers: { origin: "https://equilens.invalid","content-type": "application/json" },body: JSON.stringify(input) }),{ params: Promise.resolve({ id: "p",resultId }) })
    const finding = { ruleId: "R-1",category: "付款",quote: "合同价款为人民币 1,000,000.00 元（含税）。",paragraphIndex: 0,citations: [],risk: "付款条件不完整。",basis: ["合同"],suggestion: "补充付款条件。",impact: "影响回款。" }
    const value = { schemaVersion: 1,status: "success",findings: [finding],coverage: [],input: { complete: true },rejected: [],warnings: [] }
    // Bypass 1: the browser cannot create a contract-review result.
    assert.equal((await invoke({ kind: "contract-review",baseVersionId: "",operationId: "forged-create",reason: "人工新建",value,sources: [],dependencies: [] })).status,403)
    // A machine execution creates the immutable base version.
    const machine = await service.saveResultRevision(identity,authorize,{ projectId: "p",kind: "contract-review",baseVersionId: "",operationId: "machine-1",reason: "机器成果",value,sources: [],dependencies: [] },{ output: value,taskId: "task-1",attempt: 1,executionToken: "token-1" })
    const decisions = [{ findingIndex: 0,ruleId: "R-1",decision: "采纳" as const,reason: "采纳该风险。" }]
    const revision = { kind: "contract-review",baseVersionId: machine.versionId,operationId: "revision-1",reason: "人工处理决定",value: { ...value,findingDecisions: decisions },sources: [],dependencies: [] }
    const accepted = await invoke(revision,machine.resultId)
    assert.equal(accepted.status,200)
    const acceptedBody = (await accepted.json()) as { resultId: string; versionId: string; review: unknown }
    assert.equal(acceptedBody.review,null)
    // Forgeries must be based on the current version so they reach the machine-field projection check.
    const current = { ...revision,baseVersionId: acceptedBody.versionId }
    // Bypass 2: machine fields cannot be rewritten through the revision route.
    assert.equal((await invoke({ ...current,operationId: "forged-quote",value: { ...value,findings: [{ ...finding,quote: "被改写的引文" }],findingDecisions: decisions } },machine.resultId)).status,400)
    assert.equal((await invoke({ ...current,operationId: "forged-coverage",value: { ...value,coverage: [{ category: "付款",status: "已检查" }],findingDecisions: decisions } },machine.resultId)).status,400)
    assert.equal((await invoke({ ...current,operationId: "forged-status",value: { ...value,status: "partial",findingDecisions: decisions } },machine.resultId)).status,400)
    // Bypass 3: server-owned options and machine output never reach the revision route.
    for (const extra of [{ serverOwned: true },{ machineOutput: {} },{ options: {} }]) assert.equal((await invoke({ ...current,operationId: "forged-extra",...extra },machine.resultId)).status,400)
  } finally {
    await db.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})
