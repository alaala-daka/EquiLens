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
