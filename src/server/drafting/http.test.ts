import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { AuthError } from "../auth/errors"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { draftingHandler, type DraftingHttpServices } from "./http"
import { projectId, setupDrafting, specialtyFields, testIdentity } from "./drafting-test-fixtures"

/**
 * C5 drafting HTTP contract (spec 01 §8.2.4, plan §5 C5): same-origin writes,
 * project-scoped authorization on every request, uniform 404 for unknown or
 * cross-project resources, viewer refusal, strict body allowlists, private
 * no-store responses and bounded bodies.
 */
const origin = "https://equilens.invalid"

async function setupHttp() {
  const fixture = await setupDrafting()
  const material = await fixture.addMaterial(["原合同正文。"], { title: "原专业分包合同" })
  let authFailure: Error | undefined
  let role: "editor" | "viewer" = "editor"
  const authorize = async (identity: AuthIdentity, target: string, action: "read" | "edit" | "manage") => {
    if (target !== projectId) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    return { projectId: target, action, role, identity }
  }
  const services = async (): Promise<DraftingHttpServices> => ({
    identity: async () => { if (authFailure) throw authFailure; return testIdentity },
    authorize,
    service: fixture.service,
  })
  const invoke = (
    operation: Parameters<typeof draftingHandler>[1],
    input?: unknown,
    options: { method?: string; raw?: string; origin?: string; type?: string; project?: string; inputId?: string; resultId?: string } = {},
  ) => draftingHandler(services, operation)(
    new NextRequest(`${origin}/api/projects/${options.project ?? projectId}/drafting-inputs`, {
      method: options.method ?? "GET",
      headers: { origin: options.origin ?? origin, "content-type": options.type ?? "application/json" },
      ...(options.raw !== undefined ? { body: options.raw } : input !== undefined ? { body: JSON.stringify(input) } : {}),
    }),
    { params: Promise.resolve({ id: options.project ?? projectId, inputId: options.inputId, resultId: options.resultId }) },
  )
  return {
    fixture, material, invoke,
    setFailure: (failure?: Error) => { authFailure = failure },
    setRole: (next: "editor" | "viewer") => { role = next },
  }
}

test("C5 HTTP: list/get inputs are private no-store, include the code templates and keep unknown/cross-project 404", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke } = await setupHttp()
  try {
    const saved = await fixture.saveInput("specialty-subcontract-v1", specialtyFields())
    const list = await invoke("list-inputs")
    assert.equal(list.status, 200)
    assert.equal(list.headers.get("cache-control"), "private, no-store")
    const body = await list.json() as { templates: Array<{ id: string; status: string }>; inputs: Array<{ inputId: string }> }
    assert.deepEqual(body.templates.map(template => template.id), ["specialty-subcontract-v1", "supplementary-agreement-v1"])
    assert.ok(body.templates.every(template => template.status === "待核对"))
    assert.equal(body.inputs.length, 1)
    const detail = await invoke("get-input", undefined, { inputId: saved.input.inputId })
    assert.equal(detail.status, 200)
    assert.equal(detail.headers.get("cache-control"), "private, no-store")
    assert.equal((await detail.json() as { input: { inputId: string } }).input.inputId, saved.input.inputId)
    for (const options of [{ inputId: "missing-input" }, { inputId: saved.input.inputId, project: "other-project" }]) {
      const response = await invoke("get-input", undefined, options)
      assert.equal(response.status, 404)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
    }
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("C5 HTTP: save-input enforces same origin, role, strict allowlist and idempotent versions", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke, setRole } = await setupHttp()
  try {
    const body = { templateId: "specialty-subcontract-v1", baseVersionId: "", operationId: "http-input-op-1", fields: specialtyFields() }
    assert.equal((await invoke("save-input", body, { method: "POST", origin: "https://foreign.invalid" })).status, 403)
    assert.equal((await invoke("save-input", body, { method: "POST", type: "text/plain" })).status, 400)
    assert.equal((await invoke("save-input", undefined, { method: "POST", raw: "{" })).status, 400)
    assert.equal((await invoke("save-input", undefined, { method: "POST", raw: "[]" })).status, 400)
    for (const extra of [
      { projectId }, { kind: "specialty-subcontract" }, { value: {} }, { sources: [] }, { dependencies: [] },
      { paragraphs: [] }, { missing: [] }, { template: {} }, { manifest: {} }, { model: "https://model.invalid/v1" },
    ]) {
      assert.equal((await invoke("save-input", { ...body, ...extra }, { method: "POST" })).status, 400, JSON.stringify(extra))
    }
    const created = await invoke("save-input", body, { method: "POST" })
    assert.equal(created.status, 200)
    assert.equal(created.headers.get("cache-control"), "private, no-store")
    const first = await created.json() as { input: { inputId: string; versionId: string; version: number } }
    assert.equal(first.input.version, 1)
    const repeat = await invoke("save-input", body, { method: "POST" })
    assert.equal((await repeat.json() as { input: { versionId: string } }).input.versionId, first.input.versionId)
    const updated = await invoke("save-input", {
      ...body, inputId: first.input.inputId, baseVersionId: first.input.versionId, operationId: "http-input-op-2",
      fields: specialtyFields({ "project.name": "二期项目" }),
    }, { method: "POST" })
    assert.equal(updated.status, 200)
    assert.equal((await updated.json() as { input: { version: number } }).input.version, 2)
    const stale = await invoke("save-input", {
      ...body, inputId: first.input.inputId, baseVersionId: first.input.versionId, operationId: "http-input-op-3",
    }, { method: "POST" })
    assert.equal(stale.status, 409)
    const invalidField = await invoke("save-input", { ...body, operationId: "http-input-op-3", fields: { ...specialtyFields(), "pricing.amount": "1,000" } }, { method: "POST" })
    assert.equal(invalidField.status, 400)
    setRole("viewer")
    assert.equal((await invoke("save-input", body, { method: "POST" })).status, 403)
    assert.equal((await invoke("list-inputs")).status, 200)
    assert.equal((await invoke("save-input", body, { method: "POST", project: "other-project" })).status, 404)
    const oversized = JSON.stringify({ ...body, fields: { ...specialtyFields(), pad: "x".repeat(300 * 1024) } })
    assert.equal((await invoke("save-input", undefined, { method: "POST", raw: oversized })).status, 429)
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("C5 HTTP: generate and revise are role-guarded, body-strict and return partial drafts", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke, setRole } = await setupHttp()
  try {
    const saved = await fixture.saveInput("specialty-subcontract-v1", specialtyFields())
    const generateBody = {
      inputId: saved.input.inputId, versionId: saved.input.versionId, sha256: saved.input.sha256,
      operationId: "http-generate-1", reason: "生成草稿",
    }
    assert.equal((await invoke("generate", generateBody, { method: "POST", origin: "https://foreign.invalid" })).status, 403)
    for (const extra of [
      { projectId }, { kind: "specialty-subcontract" }, { value: {} }, { sources: [] }, { paragraphs: [] }, { template: {} },
    ]) {
      assert.equal((await invoke("generate", { ...generateBody, ...extra }, { method: "POST" })).status, 400)
    }
    assert.equal((await invoke("generate", { ...generateBody, sha256: "0".repeat(64) }, { method: "POST" })).status, 409)
    assert.equal((await invoke("generate", { ...generateBody, inputId: "missing-input" }, { method: "POST" })).status, 404)
    const generated = await invoke("generate", generateBody, { method: "POST" })
    assert.equal(generated.status, 200)
    assert.equal(generated.headers.get("cache-control"), "private, no-store")
    const draft = await generated.json() as { kind: string; origin: string; validation: { status: string }; resultId: string; versionId: string; sha256: string; value: { status: string } }
    assert.equal(draft.kind, "specialty-subcontract")
    assert.equal(draft.origin, "human")
    assert.equal(draft.validation.status, "partial")
    assert.equal(draft.value.status, "partial")

    const reviseBody = {
      baseVersionId: draft.versionId, inputId: saved.input.inputId, versionId: saved.input.versionId,
      sha256: saved.input.sha256, operationId: "http-revise-1", reason: "重渲染",
    }
    assert.equal((await invoke("revise", reviseBody, { method: "POST", resultId: draft.resultId })).status, 200)
    assert.equal((await invoke("revise", { ...reviseBody, operationId: "http-revise-2" }, { method: "POST", resultId: draft.resultId })).status, 409)
    assert.equal((await invoke("revise", { ...reviseBody, operationId: "http-revise-3" }, { method: "POST", resultId: "missing-result" })).status, 404)
    for (const extra of [{ projectId }, { value: {} }, { sources: [] }, { dependencies: [] }]) {
      assert.equal((await invoke("revise", { ...reviseBody, ...extra }, { method: "POST", resultId: draft.resultId })).status, 400)
    }
    setRole("viewer")
    assert.equal((await invoke("generate", generateBody, { method: "POST" })).status, 403)
    assert.equal((await invoke("revise", reviseBody, { method: "POST", resultId: draft.resultId })).status, 403)
    // Unknown/cross-project result ids resolve to the uniform 404 for the throw-away project path.
    assert.equal((await invoke("revise", reviseBody, { method: "POST", resultId: draft.resultId, project: "other-project" })).status, 404)
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})

test("C5 HTTP: auth failures map to 401/503 without leaking details", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = origin
  const { fixture, invoke, setFailure } = await setupHttp()
  try {
    setFailure(new AuthError("UNAUTHENTICATED", "请先登录。"))
    const unauthenticated = await invoke("list-inputs")
    assert.equal(unauthenticated.status, 401)
    assert.equal((await unauthenticated.json()).error.code, "UNAUTHENTICATED")
    setFailure(new AuthError("AUTH_UNAVAILABLE", "内部认证故障细节。"))
    const unavailable = await invoke("list-inputs")
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { error: { code: "AUTH_UNAVAILABLE", message: "身份验证失败。" } })
  } finally {
    await fixture.close()
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous
  }
})
