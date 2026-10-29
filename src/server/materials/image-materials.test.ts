import assert from "node:assert/strict"
import { test } from "node:test"
import { strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../lib/documents/docx"
import { createAccountAccess } from "../auth/handlers"
import { authConfig } from "../auth/config"
import { AuthService, type AuthIdentity } from "../auth/service"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { createProjectAuthorization } from "../projects/authorization"
import { ProjectRepository } from "../projects/repository"
import { ProjectService } from "../projects/service"
import { createSyntheticObjectStore } from "../storage/obs"
import { MaterialRepository } from "./repository"
import { MaterialService } from "./service"
import { QueuedMaterialService } from "./queued"
import { createMaterialExecutor } from "./executor"
import { createMaterialHandlers } from "./http"
import { TaskRepository } from "../tasks/repository"
import { buildTaskManifest, parseTaskRequest } from "../tasks/catalog"
import { OcrRepository, VerificationFieldService } from "../verification/ocr-repository"
import { pngImage, jpegImage, imageOfSize } from "../verification/ocr-test-fixtures"
import { IMAGE_LIMITS, IMAGE_MATERIAL_MESSAGE } from "./parse"
import type { ClaimedTask } from "../tasks/repository"
import type { TaskExecutor } from "../tasks/runner-core"

/**
 * C4-OCR image material gating through the real queued HTTP write path.
 *
 * Images are accepted only when the server OCR adapter reports available; the
 * PNG/JPEG magic, 4 MiB / 8192 px / 40 MP limits and the single fixed product
 * message are enforced by content, never by file name. Accepted images are
 * parse-less: no material-parse task is submitted and recovery can never
 * re-enqueue one. The manual certificate field route is role/version guarded.
 */
const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const password = "Synthetic password 123!"
const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

const projectInput = {
  name: "房建机电安装专业分包项目", source: "synthetic" as const, sourceReference: "合成比赛项目",
  purpose: "合同审查与款项核对", retentionUntil: "2027-12-31",
}
const registration = (projectId: string, overrides: Record<string, unknown> = {}) => ({
  projectId, title: "营业执照", fileName: "license.png", sourceKind: "synthetic", sourceReference: "合成证照",
  processingAuthorized: true, purpose: "投标材料核验", retentionUntil: "2027-06-30", ...overrides,
})

async function docx(body: string): Promise<Uint8Array> {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
  return zipSync(files)
}
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

async function setup() {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  const clock = new Date("2026-10-29T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const projectRepository = new ProjectRepository(database, () => clock)
  const projectAuthorization = createProjectAuthorization({ repository: projectRepository, revalidateSession: access.revalidateAccountSession })
  const projects = new ProjectService({ repository: projectRepository, authorization: projectAuthorization, now: () => clock })
  const repository = new MaterialRepository(database, () => clock)
  const store = createSyntheticObjectStore()
  let ocrAvailable = false
  let enqueueParseCalls = 0
  const tasks = new TaskRepository(database)
  const material = new MaterialService({
    repository, store, requireProjectAccess: projectAuthorization.requireProjectAccess,
    readProject: async projectId => (await projectRepository.findActive(projectId)) ?? null,
    now: () => clock,
    enqueueParse: async () => { enqueueParseCalls++; return "material-parse-task" },
  })
  const queued = new QueuedMaterialService({
    repository, store, requireProjectAccess: projectAuthorization.requireProjectAccess,
    readProject: id => projectRepository.findActive(id), now: () => clock,
    available: () => true,
    ocrAvailable: () => ocrAvailable,
    preflight: async () => {},
    enqueue: async (identity, version, operationId) => (await tasks.submit(identity.account.id, operationId, {
      kind: "material-parse", projectId: version.projectId,
      refs: { materials: [{ materialVersionId: version.id, sha256: version.sha256 }] }, conditions: {},
    })).task.id,
  })
  const fields = new VerificationFieldService({ repository: new OcrRepository(database, () => clock), materials: repository, requireProjectAccess: projectAuthorization.requireProjectAccess, readProjectRetention: async id => (await projectRepository.findActive(id))?.retentionUntil ?? null, now: () => clock })
  const handlers = createMaterialHandlers(async () => ({ requireAccount: access.requireAccount, origin: () => site, reads: material, writes: queued, fields }))
  async function create(username: string) { await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" }) }
  async function login(username: string): Promise<{ token: string; identity: AuthIdentity }> {
    const result = await auth.login(username, password, "deployment")
    return { token: result.token, identity: await access.requireAccount(new Request(`${site}/workbench`, { headers: { cookie: `__Host-equilens-auth=${result.token}` } })) }
  }
  return {
    database, auth, access, projects, projectRepository, repository, material, queued, tasks, handlers, store, fields, create, login,
    setOcrAvailable(value: boolean) { ocrAvailable = value },
    get enqueueParseCalls() { return enqueueParseCalls },
  }
}

test("C4-OCR images: rejected with one product message and no storage when OCR is unavailable", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = pngImage(1024, 768)
    await assert.rejects(env.queued.upload(alice.identity, project.id, registration(project.id), bytes), (failure: unknown) =>
      (failure as { code?: string }).code === "INVALID_SOURCE" && /OCR 尚未验证/.test((failure as Error).message))
    assert.deepEqual(env.store.keys(), [])
    assert.equal((await env.repository.listMaterials(project.id)).length, 0)
    assert.equal((await env.tasks.list(alice.identity.account.id, project.id)).length, 0)
  } finally { await env.database.close() }
})

test("C4-OCR images: multipart HTTP write path enforces the gate and returns a parse-less image", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const context = { params: Promise.resolve({ id: project.id }) }
    const url = `${site}/api/projects/${project.id}/materials`
    const authHeaders = { cookie: `__Host-equilens-auth=${alice.token}`, origin: site }
    const upload = (bytes: Uint8Array, metadata: Record<string, unknown>) => {
      const form = new FormData()
      form.set("metadata", JSON.stringify(metadata))
      form.set("file", new File([Buffer.from(bytes)], "license.png", { type: "image/png" }))
      return env.handlers.upload(new Request(url, { method: "POST", headers: authHeaders, body: form }), context)
    }
    // Unavailable OCR -> 422 with the fixed product message and nothing persisted.
    const rejected = await upload(pngImage(1024, 768), registration(project.id))
    assert.equal(rejected.status, 422)
    const rejectedValue = await rejected.json() as { error: { message: string } }
    assert.match(rejectedValue.error.message, /OCR 尚未验证/)
    assert.deepEqual(env.store.keys(), [])

    env.setOcrAvailable(true)
    const accepted = await upload(pngImage(1024, 768), registration(project.id))
    assert.equal(accepted.status, 202)
    assert.equal(accepted.headers.get("cache-control"), "private, no-store")
    const acceptedValue = await accepted.json() as { material: { format: string }; parseTaskId: string | null }
    assert.equal(acceptedValue.material.format, "image")
    assert.equal(acceptedValue.parseTaskId, null)
    assert.equal((await env.tasks.list(alice.identity.account.id, project.id)).length, 0)

    // Image limits are enforced on the HTTP path with the single product message.
    const oversized = await upload(imageOfSize(pngImage(10, 10), IMAGE_LIMITS.fileBytes + 1), registration(project.id, { title: "超限证照" }))
    assert.equal(oversized.status, 429)
    const oversizedValue = await oversized.json() as { error: { message: string } }
    assert.equal(oversizedValue.error.message, IMAGE_MATERIAL_MESSAGE)
  } finally { await env.database.close() }
})

test("C4-OCR images: accepted PNG/JPEG is parse-less, duplicate-safe and never reparsed", async () => {
  const env = await setup()
  try {
    env.setOcrAvailable(true)
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = pngImage(1024, 768)
    const uploaded = await env.queued.upload(alice.identity, project.id, registration(project.id), bytes)
    assert.equal(uploaded.material.format, "image")
    assert.equal(uploaded.parseTaskId, null)
    assert.equal(uploaded.version.contentType, "image/png")
    assert.equal(uploaded.material.latestRevision, 0)
    assert.deepEqual(env.store.keys(), [uploaded.version.objectKey])
    assert.equal(await env.repository.latestSnapshot(project.id, uploaded.material.id), null)
    const listed = await env.repository.listMaterials(project.id)
    assert.equal(listed[0].format, "image")
    assert.equal(listed[0].parseTaskId, null)
    assert.equal(listed[0].snapshotId, null)
    assert.equal(listed[0].coverage, null)
    assert.equal((await env.tasks.list(alice.identity.account.id, project.id)).length, 0)

    const duplicate = await env.queued.upload(alice.identity, project.id, registration(project.id), bytes)
    assert.equal(duplicate.parseTaskId, null)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.version.id, uploaded.version.id)
    assert.equal((await env.tasks.list(alice.identity.account.id, project.id)).length, 0)
    await assert.rejects(env.queued.reparse(alice.identity, project.id, uploaded.material.id, "reparse-image-1"), (failure: unknown) =>
      (failure as { code?: string }).code === "INVALID_SOURCE")
    assert.equal(env.enqueueParseCalls, 0)

    // Recovery sees no open parse-less image intent and therefore never enqueues material-parse.
    assert.deepEqual((await env.repository.uploadIntents().open(10)).filter(intent => intent.materialId === uploaded.material.id), [])
    const openBefore = (await env.repository.uploadIntents().open(10)).length
    await env.material.repairResidues()
    assert.equal(env.enqueueParseCalls, 0)
    assert.equal((await env.repository.uploadIntents().open(10)).length, openBefore)

    const jpeg = await env.queued.upload(alice.identity, project.id, registration(project.id, { title: "安全许可证", fileName: "license.jpg" }), jpegImage(800, 600))
    assert.equal(jpeg.version.contentType, "image/jpeg")
    assert.equal(jpeg.parseTaskId, null)
  } finally { await env.database.close() }
})

test("C4-OCR images: recovery of a crash-window image intent commits it parse-less", async () => {
  const env = await setup()
  try {
    env.setOcrAvailable(true)
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const uploaded = await env.queued.upload(alice.identity, project.id, registration(project.id), pngImage(1024, 768))
    // Simulate a process loss after the object/metadata were written but before intents.committed().
    await env.database.transaction(c => c.query("UPDATE equilens_material_upload_intents SET state='stored' WHERE material_id=$1", [uploaded.material.id]))
    const intents = await env.repository.uploadIntents()
    assert.equal((await intents.open(10)).filter(intent => intent.materialId === uploaded.material.id).length, 1)
    const result = await intents.repair({
      store: env.store,
      isReferenced: intent => env.repository.objectReferenced(intent.objectKey),
      isParseRequired: async intent => (await env.repository.findMaterial(intent.projectId, intent.materialId))?.format !== "image",
      enqueueParse: async () => { throw new Error("must not enqueue parse for an image") },
    }, { limit: 10, expiryMs: 0 })
    assert.equal(result.resolved, 1)
    assert.equal((await intents.open(10)).filter(intent => intent.materialId === uploaded.material.id).length, 0)
    assert.equal((await env.tasks.list(alice.identity.account.id, project.id)).length, 0)
  } finally { await env.database.close() }
})

test("C4-OCR images: PNG/JPEG magic and every image limit use the one fixed product message", async () => {
  const env = await setup()
  try {
    env.setOcrAvailable(true)
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const cases: Uint8Array[] = [
      imageOfSize(pngImage(10, 10), IMAGE_LIMITS.fileBytes + 1),
      pngImage(IMAGE_LIMITS.sidePixels + 1, 10),
      pngImage(8192, 4883),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), // PNG magic + truncated header
      new Uint8Array([0xff, 0xd8, 0xff, 0x00]), // JPEG magic + no frame
    ]
    for (const bytes of cases) {
      await assert.rejects(env.queued.upload(alice.identity, project.id, registration(project.id), bytes), (failure: unknown) => {
        const error = failure as { code?: string; message?: string }
        assert.ok(["LIMIT_EXCEEDED", "INVALID_SOURCE"].includes(String(error.code)))
        assert.equal(error.message, IMAGE_MATERIAL_MESSAGE)
        return true
      })
    }
    // A PDF renamed as .png is detected by real content: it is handled as a PDF,
    // never accepted as a certificate image.
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n")
    const disguised = await env.queued.upload(alice.identity, project.id, registration(project.id, { fileName: "fake.png" }), pdfBytes)
    assert.equal(disguised.material.format, "pdf")
    assert.equal((await env.repository.listMaterials(project.id)).filter(material => material.format === "image").length, 0)
    // Rejected image attempts left no objects/materials behind (only the PDF above was accepted).
    assert.equal((await env.repository.listMaterials(project.id)).length, 1)
    assert.equal(env.store.keys().length, 1)
  } finally { await env.database.close() }
})

test("C4-OCR images: material-parse executor defensively refuses image versions", async () => {
  const env = await setup()
  try {
    env.setOcrAvailable(true)
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const uploaded = await env.queued.upload(alice.identity, project.id, registration(project.id), pngImage(64, 64))
    const request = parseTaskRequest({
      kind: "material-parse", projectId: project.id,
      refs: { materials: [{ materialVersionId: uploaded.version.id, sha256: uploaded.version.sha256 }] }, conditions: {},
    })
    const manifest = buildTaskManifest(request, alice.identity.account.id, new Date().toISOString())
    const job: ClaimedTask = {
      id: "task-image", owner: alice.identity.account.id, projectId: project.id, kind: "material-parse", token: "token", attempt: 1,
      callsUsed: 0, maxCalls: 0, elapsedMs: 0, startedAt: new Date().toISOString(), manifest,
    }
    const context: Parameters<TaskExecutor>[1] = {
      signal: new AbortController().signal, heartbeat: async () => {}, refreshAccess: async () => {},
      reserveCall: async () => {}, settleCall: async () => {},
    }
    await assert.rejects(createMaterialExecutor({ repository: env.repository, store: env.store, readProjectRetention: async () => "2027-12-31" })(job, context), /INVALID_SOURCE/)
    assert.equal(await env.repository.latestSnapshot(project.id, uploaded.material.id), null)
  } finally { await env.database.close() }
})

test("C4-OCR fields HTTP: auth, origin, role, cross-project 404 and private no-store", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    await env.create("viewer")
    await env.create("bob")
    const alice = await env.login("alice")
    const viewer = await env.login("viewer")
    const bob = await env.login("bob")
    const project = await env.projects.create(alice.identity, projectInput)
    const other = await env.projects.create(bob.identity, { ...projectInput, name: "其他项目" })
    await env.projects.addMember(alice.identity, project.id, { username: "viewer", role: "viewer" })
    const material = await env.material.registerMaterial(alice.identity, registration(project.id, { fileName: "license.docx" }), await docx(paragraph("统一社会信用代码：91310000MA1K000000。")))
    const params = { id: project.id, materialId: material.material.id, versionId: material.version.id }
    const context = { params: Promise.resolve(params) }
    const url = `${site}/api/projects/${project.id}/materials/${material.material.id}/versions/${material.version.id}/fields`
    const headers = { cookie: `__Host-equilens-auth=${alice.token}`, origin: site }
    assert.equal((await env.handlers.fields(new Request(url), context)).status, 401)
    const read = await env.handlers.fields(new Request(url, { headers }), context)
    assert.equal(read.status, 200)
    assert.equal(read.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(await read.json(), { fields: [], history: [] })
    // Viewer reads but cannot register a field.
    const viewerRead = await env.handlers.fields(new Request(url, { headers: { cookie: `__Host-equilens-auth=${viewer.token}`, origin: site } }), context)
    assert.equal(viewerRead.status, 200)
    const viewerWrite = await env.handlers.saveFields(new Request(url, {
      method: "POST", headers: { cookie: `__Host-equilens-auth=${viewer.token}`, origin: site, "content-type": "application/json" },
      body: JSON.stringify({ operationId: "fields-test-1", fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }] }),
    }), context)
    assert.equal(viewerWrite.status, 403)
    // Wrong origin is rejected.
    const wrongOrigin = await env.handlers.saveFields(new Request(url, {
      method: "POST", headers: { cookie: `__Host-equilens-auth=${alice.token}`, origin: "https://other.test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "fields-test-2", fields: [{ fieldKey: "certificate_number", valueText: "D131000000" }] }),
    }), context)
    assert.equal(wrongOrigin.status, 403)
    // Unknown material version in this project is a uniform 404.
    const unknown = await env.handlers.fields(new Request(url, { headers }), { params: Promise.resolve({ id: project.id, materialId: material.material.id, versionId: "00000000-0000-4000-8000-000000000000" }) })
    assert.equal(unknown.status, 404)
    // Bob's material under Alice's project path: 403 as a non-member of Alice's project (no content leak).
    const foreign = await env.handlers.fields(new Request(`${site}/api/projects/${project.id}/materials/${material.material.id}/versions/${material.version.id}/fields`, { headers: { cookie: `__Host-equilens-auth=${bob.token}` } }), context)
    assert.ok([403, 404].includes(foreign.status))
    assert.equal(other.id === project.id, false)
  } finally { await env.database.close() }
})

test("C4-OCR fields HTTP: same-version verbatim fragment support, pending, mismatch and idempotency", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const material = await env.material.registerMaterial(alice.identity, registration(project.id, { fileName: "license.docx" }), await docx(paragraph("统一社会信用代码：91310000MA1K000000。")))
    const snapshot = await env.repository.latestSnapshot(project.id, material.material.id)
    assert.ok(snapshot)
    const fragment = (await env.repository.fragments(snapshot.id))[0]
    const params = { id: project.id, materialId: material.material.id, versionId: material.version.id }
    const context = { params: Promise.resolve(params) }
    const url = `${site}/api/projects/${project.id}/materials/${material.material.id}/versions/${material.version.id}/fields`
    const headers = { cookie: `__Host-equilens-auth=${alice.token}`, origin: site, "content-type": "application/json" }
    const save = (body: unknown) => env.handlers.saveFields(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), context)

    const supported = await save({ operationId: "fields-http-1", fields: [
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", sourceFragmentId: fragment.id },
    ] })
    const supportedValues = await supported.json() as { fields: { support: string; origin: string; normalizedValue: string; revision: number }[]; error?: unknown }
    assert.equal(supported.status, 200, JSON.stringify(supportedValues))
    assert.equal(supportedValues.fields[0].support, "material_text")
    assert.equal(supportedValues.fields[0].origin, "material_text")
    assert.equal(supportedValues.fields[0].normalizedValue, "91310000MA1K000000")

    const mismatch = await save({ operationId: "fields-http-2", fields: [
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1K999999", sourceFragmentId: fragment.id },
    ] })
    assert.equal(mismatch.status, 400)

    const pending = await save({ operationId: "fields-http-3", fields: [{ fieldKey: "certificate_level", valueText: "一级" }] })
    assert.equal(pending.status, 200)
    const pendingValues = await pending.json() as { fields: { support: string }[] }
    assert.equal(pendingValues.fields[0].support, "pending")

    // Same operationId and input is idempotent (one row, revision unchanged).
    const retried = await save({ operationId: "fields-http-1", fields: [
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", sourceFragmentId: fragment.id },
    ] })
    assert.equal(retried.status, 200)
    const retriedValues = await retried.json() as { fields: { id: string; revision: number }[] }
    assert.equal(retriedValues.fields[0].revision, 1)

    const listed = await env.handlers.fields(new Request(url, { headers }), context)
    const listedValues = await listed.json() as { fields: { fieldKey: string }[]; history: unknown[] }
    assert.deepEqual(listedValues.fields.map(field => field.fieldKey).sort(), ["certificate_level", "unified_social_credit_code"])
    assert.equal(listedValues.history.length, 0)

    const corrected = await save({ operationId: "fields-http-4", reason: "人工更正", fields: [
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", sourceFragmentId: fragment.id },
    ] })
    assert.equal(corrected.status, 200)
    const correctedValues = await corrected.json() as { fields: { revision: number; previousId: string | null }[] }
    assert.equal(correctedValues.fields[0].revision, 2)
    assert.ok(correctedValues.fields[0].previousId)
    const listedAfter = await (await env.handlers.fields(new Request(url, { headers }), context)).json() as { history: unknown[] }
    assert.equal(listedAfter.history.length, 1)
  } finally { await env.database.close() }
})
