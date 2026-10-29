import assert from "node:assert/strict"
import { test } from "node:test"
import { DOCX_TYPE } from "../documents/types"
import { createProjectDraftingClient, type ProjectDraftingClientOptions } from "./drafting-client"
import type { ProjectResultView } from "./reviews-client"
import { ProjectReviewError } from "./reviews-client"

type Call = { url: string; init: RequestInit }
type Responder = (url: string, init: RequestInit) => Response

function harness(responder: Responder, overrides: Partial<ProjectDraftingClientOptions> = {}) {
  const calls: Call[] = []
  let invalid: ProjectReviewError | null = null
  const client = createProjectDraftingClient({
    projectId: "project 1",
    isCurrent: () => true,
    canEdit: () => true,
    onAccessInvalid: failure => { invalid = failure },
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return responder(String(url), init)
    }) as typeof fetch,
    ...overrides,
  })
  return { client, calls, accessInvalid: () => invalid }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const template = {
  id: "specialty-subcontract-v1", kind: "specialty-subcontract", version: "v1", sha256: "a".repeat(64), status: "待核对",
  label: "专业分包合同", summary: "测试", renderVersion: "drafting-render-v1", originalContract: null,
  sections: [{ id: "project", title: "项目与地点" }],
  fields: [{ id: "project.name", label: "项目名称", section: "project", kind: "text", required: "always", source: "proposed", maxLength: 20 }],
}

const inputDetail = {
  inputId: "input-1", kind: "specialty-subcontract", templateId: template.id, templateLabel: template.label,
  templateStatus: "待核对", templateVersion: "v1", templateSha256: template.sha256, version: 1, versionId: "version-1",
  sha256: "b".repeat(64), createdAt: "2026-10-29T00:00:00.000Z", createdBy: "account", missingCount: 0,
  originalContractTitle: null, values: { "project.name": "项目甲" }, originalContract: null, missing: [],
}

const draftValue = {
  schemaVersion: 1, kind: "specialty-subcontract", status: "partial",
  template: { id: template.id, version: "v1", sha256: template.sha256, status: "待核对" },
  input: { inputId: "input-1", versionId: "version-1", version: 1, sha256: "b".repeat(64) },
  fields: [], originalContract: null, missing: [], paragraphs: ["草稿正文"],
  warnings: [{ code: "TEMPLATE_UNREVIEWED", message: "待核对" }], renderVersion: "drafting-render-v1",
}

function resultView(overrides: Partial<ProjectResultView> = {}): ProjectResultView {
  return {
    projectId: "project 1", resultId: "result-1", versionId: "result-version-1", sha256: "c".repeat(64),
    kind: "specialty-subcontract", value: draftValue, machineOutput: null, origin: "human", sources: [], dependencies: [],
    provenance: null, validation: { status: "partial", versionId: "result-version-1", checkedAt: "2026-10-29T00:00:00.000Z", issues: [] },
    review: null, createdAt: "2026-10-29T00:00:00.000Z", createdBy: "account", reason: "生成草稿", ...overrides,
  }
}

test("C5 client: list/get inputs use project-scoped paths and parse template codes", async () => {
  const { client, calls } = harness(url => {
    if (url === "/api/projects/project%201/drafting-inputs") return jsonResponse({ templates: [template], inputs: [{ inputId: "input-1" }] })
    if (url === "/api/projects/project%201/drafting-inputs/input-1") return jsonResponse({ input: inputDetail, template })
    return jsonResponse({}, 404)
  })
  const listed = await client.listInputs()
  assert.equal(listed.templates[0].status, "待核对")
  assert.equal(listed.inputs[0].inputId, "input-1")
  const detail = await client.getInput("input-1")
  assert.equal(detail.input.values["project.name"], "项目甲")
  assert.equal(calls[0].url, "/api/projects/project%201/drafting-inputs")
  assert.equal(calls[1].url, "/api/projects/project%201/drafting-inputs/input-1")
})

test("C5 client: writes are locally refused for a read-only member and carry only allowed bodies", async () => {
  const { client, calls } = harness(() => jsonResponse({ input: inputDetail, template }), { canEdit: () => false })
  await assert.rejects(client.saveInput({ templateId: template.id, baseVersionId: "", operationId: "op-input-1", fields: {} }), { code: "ACCESS_DENIED" })
  assert.equal(calls.length, 0)
  const editable = harness(url => {
    if (url.endsWith("/drafting-inputs")) return jsonResponse({ input: inputDetail, template })
    if (url.endsWith("/drafts")) return jsonResponse(resultView())
    if (url.endsWith("/revisions")) return jsonResponse(resultView({ versionId: "result-version-2" }))
    return jsonResponse({}, 404)
  })
  const saved = await editable.client.saveInput({
    templateId: template.id, inputId: "input-1", baseVersionId: "version-0", operationId: "op-input-2",
    fields: { "project.name": "项目甲" }, originalContract: { kind: "material", id: "m1", versionId: "m-v1", title: "原合同" },
  })
  assert.equal(saved.input.versionId, "version-1")
  const saveCall = editable.calls[0]
  assert.equal(saveCall.url, "/api/projects/project%201/drafting-inputs")
  assert.equal(saveCall.init.method, "POST")
  assert.deepEqual(JSON.parse(String(saveCall.init.body)), {
    templateId: template.id, inputId: "input-1", baseVersionId: "version-0", operationId: "op-input-2",
    fields: { "project.name": "项目甲" }, originalContract: { kind: "material", id: "m1", versionId: "m-v1", title: "原合同" },
  })
  await editable.client.generateDraft({ inputId: "input-1", versionId: "version-1", sha256: "b".repeat(64), operationId: "op-generate-1", reason: "生成草稿" })
  assert.deepEqual(JSON.parse(String(editable.calls[1].init.body)), {
    inputId: "input-1", versionId: "version-1", sha256: "b".repeat(64), operationId: "op-generate-1", reason: "生成草稿",
  })
  await editable.client.reviseDraft("result-1", {
    baseVersionId: "result-version-1", inputId: "input-1", versionId: "version-2", sha256: "b".repeat(64),
    operationId: "op-revise-1", reason: "重渲染",
  })
  assert.equal(editable.calls[2].url, "/api/projects/project%201/drafts/result-1/revisions")
  assert.deepEqual(JSON.parse(String(editable.calls[2].init.body)), {
    baseVersionId: "result-version-1", inputId: "input-1", versionId: "version-2", sha256: "b".repeat(64),
    operationId: "op-revise-1", reason: "重渲染",
  })
})

test("C5 client: draft reads filter non-draft kinds and support validate/review/export/download", async () => {
  const { client, calls } = harness(url => {
    if (url === "/api/projects/project%201/results") return jsonResponse([resultView(), resultView({ resultId: "bid-1", kind: "bid-verification" })])
    if (url.includes("/validate")) return jsonResponse({ status: "partial", versionId: "result-version-1", checkedAt: "now", issues: [] })
    if (url.includes("/review")) return jsonResponse(resultView({ review: { versionId: "result-version-1", decision: "changes_requested", comment: "补齐", reviewedBy: "a", reviewedAt: "now" } }))
    if (url.endsWith("/exports")) return jsonResponse([{ exportId: "export-1" }])
    if (url.includes("/content")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": DOCX_TYPE } })
    return jsonResponse({}, 404)
  })
  const drafts = await client.listDrafts()
  assert.deepEqual(drafts.map(draft => draft.resultId), ["result-1"])
  assert.equal((await client.validateDraft({ resultId: "result-1", versionId: "result-version-1", sha256: "c".repeat(64) })).status, "partial")
  const reviewed = await client.reviewDraft({ resultId: "result-1", versionId: "result-version-1", sha256: "c".repeat(64), decision: "changes_requested", comment: "补齐" })
  assert.equal(reviewed.review?.decision, "changes_requested")
  assert.deepEqual(await client.listExports("result-1"), [{ exportId: "export-1" }])
  const blob = await client.downloadExport("result-1", "export-1")
  assert.equal(blob.size, 3)
  assert.equal(calls.some(call => call.init.method === "POST" && call.url.includes("/review")), true)
})

test("C5 client: access/late-response guards and server error mapping stay provider-neutral", async () => {
  const auth = harness(() => jsonResponse({ error: { code: "UNAUTHENTICATED", message: "请先登录。" } }, 401))
  await assert.rejects(auth.client.listInputs(), { code: "SESSION_INVALID" })
  assert.equal(auth.accessInvalid()?.code, "SESSION_INVALID")
  const denied = harness(() => jsonResponse({ error: { code: "FORBIDDEN", message: "无权操作。" } }, 403))
  await assert.rejects(denied.client.getInput("input-1"), { code: "ACCESS_DENIED" })
  assert.equal(denied.accessInvalid()?.code, "ACCESS_DENIED")
  const conflict = harness(() => jsonResponse({ error: { code: "CONFLICT", message: "拟约定输入已有新版本，请重新读取后再保存。" } }, 409))
  await assert.rejects(conflict.client.saveInput({ templateId: template.id, baseVersionId: "", operationId: "op-input-3", fields: {} }),
    (failure: unknown) => failure instanceof ProjectReviewError && failure.code === "CONFLICT" && failure.message.includes("新版本"))
  const late = harness(() => jsonResponse({ templates: [], inputs: [] }), { isCurrent: () => false })
  await assert.rejects(late.client.listInputs(), { code: "ABORTED" })
  assert.equal(late.calls.length, 0)
  const invalid = harness(() => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }))
  await assert.rejects(invalid.client.listInputs(), { code: "FAILED" })
  const badShape = harness(() => jsonResponse({ templates: [{ id: 1 }], inputs: [] }))
  await assert.rejects(badShape.client.listInputs(), { code: "FAILED" })
})
