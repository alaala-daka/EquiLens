import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { AuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { verificationHandler, type VerificationHttpServices } from "./http"
import {
  projectId, setupVerification, testAuthorizer, testIdentity, type VerificationFixture,
} from "./verification-test-fixtures"

/**
 * C4-VERIFY HTTP contract (spec 01 §8.2.3/§4.9, plan §4.9): auth/role isolation,
 * uniform 404 for unknown or non-C4 resources, strict write bodies, same-origin
 * writes, size limits and private no-store on every response.
 */
const origin = "https://equilens.invalid"

async function setupHttp() {
  const fixture = await setupVerification()
  const tender = fixture.materials[0]
  const requirementSet = await fixture.saveRequirementSet()
  const other = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
    projectId, kind: "test-result", baseVersionId: "", operationId: "unrelated", reason: "其他成果",
    value: { text: "other" }, sources: [], dependencies: [],
  })
  let authFailure: Error | undefined
  let role: "editor" | "viewer" = "editor"
  const authorize = async (identity: AuthIdentity, target: string, action: "read" | "edit" | "manage") => {
    if (target !== projectId) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    return { projectId: target, action, role, identity }
  }
  const services = async (): Promise<VerificationHttpServices> => ({
    identity: async () => { if (authFailure) throw authFailure; return testIdentity },
    authorize,
    service: fixture.service,
  })
  const invoke = (
    operation: Parameters<typeof verificationHandler>[1],
    input?: unknown,
    options: { method?: string; raw?: string; origin?: string; type?: string; resultId?: string; project?: string } = {},
  ) => verificationHandler(services, operation)(
    new NextRequest(`${origin}/api/projects/${options.project ?? projectId}/verifications`, {
      method: options.method ?? "GET",
      headers: { origin: options.origin ?? origin, "content-type": options.type ?? "application/json" },
      ...(options.raw !== undefined ? { body: options.raw } : input !== undefined ? { body: JSON.stringify(input) } : {}),
    }),
    { params: Promise.resolve({ id: options.project ?? projectId, resultId: options.resultId }) },
  )
  return { fixture, tender, requirementSet, other, invoke, setFailure: (failure?: Error) => { authFailure = failure }, setRole: (next: "editor" | "viewer") => { role = next } }
}

const requirementBody = (fixture: VerificationFixture) => ({
  baseVersionId: "",
  operationId: "http-requirement-save",
  reason: "人工确认要求集",
  value: fixture.requirementSetValue(),
})

test("verification HTTP: list/detail are private no-store and only expose the two C4 kinds", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, requirementSet, other, invoke } = await setupHttp()
  try {
    const list = await invoke("list")
    assert.equal(list.status, 200)
    assert.equal(list.headers.get("cache-control"), "private, no-store")
    const body = await list.json() as { items: Array<{ resultId: string; kind: string }> }
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].kind, "bid-requirements")
    assert.equal(body.items[0].resultId, requirementSet.resultId)
    const detail = await invoke("get", undefined, { resultId: requirementSet.resultId })
    assert.equal(detail.status, 200)
    assert.equal(detail.headers.get("cache-control"), "private, no-store")
    const detailBody = await detail.json() as { result: { resultId: string; kind: string }; records: unknown[]; stale: { hint: string | null } }
    assert.equal(detailBody.result.resultId, requirementSet.resultId)
    assert.deepEqual(detailBody.records, [])
    assert.equal(detailBody.stale.hint, null)
    // Unknown result, unrelated result kind and a cross-project project id share the uniform 404.
    for (const target of [
      { resultId: "unknown-result" },
      { resultId: other.resultId },
      { project: "other-project", resultId: requirementSet.resultId },
    ]) {
      const response = await invoke("get", undefined, target)
      assert.equal(response.status, 404, JSON.stringify(target))
      assert.equal(response.headers.get("cache-control"), "private, no-store")
    }
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("verification HTTP: requirement-set POST is same-origin, strict and role-guarded", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke, setRole } = await setupHttp()
  try {
    const saved = await invoke("requirements", requirementBody(fixture), { method: "POST" })
    assert.equal(saved.status, 200)
    assert.equal(saved.headers.get("cache-control"), "private, no-store")
    const view = await saved.json() as { kind: string; origin: string; validation: { status: string } }
    assert.equal(view.kind, "bid-requirements")
    assert.equal(view.origin, "human")
    assert.equal(view.validation.status, "valid")

    const body = requirementBody(fixture)
    assert.equal((await invoke("requirements", body, { method: "POST", origin: "https://foreign.example" })).status, 403)
    assert.equal((await invoke("requirements", body, { method: "POST", type: "text/plain" })).status, 400)
    assert.equal((await invoke("requirements", undefined, { method: "POST", raw: "{" })).status, 400)
    assert.equal((await invoke("requirements", undefined, { method: "POST", raw: "[]" })).status, 400)
    for (const extra of [
      { projectId },
      { kind: "bid-verification" },
      { sources: [] },
      { dependencies: [] },
      { manifest: {} },
      { model: "https://model.invalid/v1" },
      { origin: "machine" },
      { serverOwned: true },
      { unknown: 1 },
    ]) {
      assert.equal((await invoke("requirements", { ...body, ...extra }, { method: "POST" })).status, 400, JSON.stringify(extra))
    }
    for (const invalid of [
      { ...body, operationId: "" },
      { ...body, reason: "" },
      { ...body, value: undefined },
      { ...body, baseVersionId: undefined },
    ]) {
      assert.equal((await invoke("requirements", invalid, { method: "POST" })).status, 400)
    }
    assert.equal((await invoke("requirements", undefined, { method: "POST", raw: JSON.stringify({ ...body, reason: "x".repeat(300_000) }) })).status, 429)
    setRole("viewer")
    assert.equal((await invoke("requirements", body, { method: "POST" })).status, 403)
    assert.equal((await invoke("list")).status, 200)
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("verification HTTP: external-record POST validates scope and digest", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, requirementSet, invoke, setRole } = await setupHttp()
  try {
    const certificate = fixture.materials[1]
    fixture.addFields(certificate, [
      { fieldKey: "subject_name", valueText: "华建机电安装有限公司" },
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XX2A" },
    ])
    const { createBidVerificationExecutor } = await import("./executor")
    const { executorContext } = await import("./verification-test-fixtures")
    const job = await fixture.submitVerificationTask({
      requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
      materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
    })
    const outcome = await createBidVerificationExecutor(fixture.executorDependencies())(job, executorContext())
    assert.equal(outcome.outcome, "success")
    await fixture.finishJob(job, outcome)
    const verification = JSON.parse(String(outcome.resultSummary)) as { resultId: string; versionId: string; sha256: string }
    const record = {
      versionId: verification.versionId,
      sha256: verification.sha256,
      requirementId: "req-1",
      subject: "华建机电安装有限公司",
      certificateNo: "91310000MA1FL0XX2A",
      source: "全国建筑市场监管公共服务平台",
      queriedAt: "2026-10-29T00:00:00.000Z",
      queryConditions: "按统一社会信用代码查询",
      conclusion: "matched",
      proofMaterialVersionId: certificate.versionId,
    }
    const appended = await invoke("external-records", record, { method: "POST", resultId: verification.resultId })
    assert.equal(appended.status, 200)
    assert.equal(appended.headers.get("cache-control"), "private, no-store")
    const appendedBody = await appended.json() as { recordId: string; conclusion: string }
    assert.equal(appendedBody.conclusion, "matched")
    assert.equal((await invoke("external-records", { ...record, sha256: "f".repeat(64) }, { method: "POST", resultId: verification.resultId })).status, 409)
    assert.equal((await invoke("external-records", { ...record, requirementId: "req-unknown" }, { method: "POST", resultId: verification.resultId })).status, 400)
    assert.equal((await invoke("external-records", { ...record, source: "" }, { method: "POST", resultId: verification.resultId })).status, 400)
    assert.equal((await invoke("external-records", record, { method: "POST", origin: "https://foreign.example", resultId: verification.resultId })).status, 403)
    assert.equal((await invoke("external-records", record, { method: "POST", resultId: requirementSet.resultId })).status, 404)
    setRole("viewer")
    assert.equal((await invoke("external-records", record, { method: "POST", resultId: verification.resultId })).status, 403)
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("verification HTTP: auth failures are safe, mapped and no-store", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke, setFailure } = await setupHttp()
  try {
    for (const [code, status] of [["UNAUTHENTICATED", 401], ["AUTH_BUSY", 503], ["AUTH_UNAVAILABLE", 503], ["FORBIDDEN", 403]] as const) {
      setFailure(new AuthError(code, "private detail"))
      const response = await invoke("list")
      assert.equal(response.status, status)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      assert.ok(!(await response.text()).includes("private detail"))
    }
    setFailure(new Error("SQL credentials"))
    const unavailable = await invoke("list")
    assert.equal(unavailable.status, 503)
    assert.ok(!(await unavailable.text()).includes("SQL credentials"))
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})
