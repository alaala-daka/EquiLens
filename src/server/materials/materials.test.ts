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
import { applyProjectSchema } from "../projects/schema"
import { ProjectService } from "../projects/service"
import { createFaultyObjectStore, createSyntheticObjectStore, type PrivateObjectStore, type SyntheticObjectStore } from "../storage/obs"
import { MaterialRepository } from "./repository"
import { applyMaterialSchema, uploadIntentStatements } from "./schema"
import { MaterialService } from "./service"

const site = "https://equilens.test"
const config = () => authConfig({ APP_ORIGIN: site })
const password = "Synthetic password 123!"
const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

const projectInput = {
  name: "房建机电安装专业分包项目",
  source: "synthetic" as const,
  sourceReference: "合成比赛项目",
  purpose: "合同审查与款项核对",
  retentionUntil: "2027-12-31",
}
const registration = (projectId: string, overrides: Record<string, unknown> = {}) => ({
  projectId,
  title: "机电安装专业分包合同",
  fileName: "contract.docx",
  sourceKind: "synthetic",
  sourceReference: "合成比赛项目",
  processingAuthorized: true,
  purpose: "合同审查",
  retentionUntil: "2027-06-30",
  ...overrides,
})

async function docx(body: string): Promise<Uint8Array> {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
  return zipSync(files)
}
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

function pdf(objects: string[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")]
  objects.forEach((body, index) => parts.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")))
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"))
  return new Uint8Array(Buffer.concat(parts))
}

function scannedPdf(): Uint8Array {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    "<< /Length 34 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream",
    "<< /Type /XObject /Subtype /Image /Width 100 /Height 100 >>",
  ])
}

function encryptedPdf(): Uint8Array {
  const stream = "\nBT (机密) Tj ET\n"
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} /Encrypt 9 0 R >>\nstream${stream}endstream`,
  ])
}

async function setup(store: PrivateObjectStore = createSyntheticObjectStore()) {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  await applyMaterialSchema(database)
  await database.transaction(async c => { for (const sql of uploadIntentStatements) await c.query(sql) })
  const clock = new Date("2026-10-28T00:00:00Z")
  const auth = new AuthService(database, () => clock.getTime())
  const access = createAccountAccess({ services: () => auth, config })
  const projectRepository = new ProjectRepository(database, () => clock)
  const projectAuthorization = createProjectAuthorization({ repository: projectRepository, revalidateSession: access.revalidateAccountSession })
  const projects = new ProjectService({ repository: projectRepository, authorization: projectAuthorization, now: () => clock })
  const repository = new MaterialRepository(database, () => clock)
  const material = new MaterialService({
    repository,
    store,
    requireProjectAccess: projectAuthorization.requireProjectAccess,
    readProject: async projectId => {
      const project = await projectRepository.findActive(projectId)
      return project ? { retentionUntil: project.retentionUntil } : null
    },
    now: () => clock,
  })
  async function create(username: string) {
    await auth.maintain({ action: "create", username, password, actor: "synthetic-admin" })
  }
  async function login(username: string): Promise<{ token: string; identity: AuthIdentity }> {
    const result = await auth.login(username, password, "deployment")
    return { token: result.token, identity: await access.requireAccount(new Request(`${site}/workbench`, { headers: { cookie: `__Host-equilens-auth=${result.token}` } })) }
  }
  return { database, auth, access, projects, projectRepository, repository, material, store, create, login }
}

test("C2/AC-08: authorized DOCX registration, immutable version and source read", async () => {
  const inner = createSyntheticObjectStore()
  const env = await setup(inner)
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = await docx(paragraph("第一章 合同价款") + paragraph("合同价合计人民币 100,000 元。"))
    const result = await env.material.registerMaterial(alice.identity, registration(project.id), bytes)
    assert.equal(result.duplicate, false)
    assert.equal(result.coverage.status, "available")
    assert.equal(result.material.latestRevision, 1)
    assert.equal(result.version.sha256.length, 64)

    const parsed = await env.material.readParseSnapshot(alice.identity, { projectId: project.id, snapshotId: result.snapshot.id })
    assert.equal(parsed.snapshot.id, result.snapshot.id)
    const fragments = await env.repository.fragments(result.snapshot.id)
    assert.deepEqual(fragments.map(fragment => fragment.text), ["第一章 合同价款", "合同价合计人民币 100,000 元。"])
    const source = await env.material.readSource(alice.identity, { projectId: project.id, snapshotId: result.snapshot.id, fragmentId: fragments[0].id })
    assert.equal(source.fragment.text, "第一章 合同价款")
    assert.equal(source.fragment.paragraph, 1)

    const original = await env.material.readMaterialVersion(alice.identity, { projectId: project.id, materialId: result.material.id, versionId: result.version.id })
    assert.deepEqual(original.bytes, bytes)
    assert.equal(original.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    const summary = await env.material.listMaterials(alice.identity, project.id)
    assert.equal(summary.length, 1)
    assert.equal(summary[0].snapshotId, result.snapshot.id)
    assert.equal(inner.kind, "synthetic")
    assert.deepEqual(inner.keys(), [result.version.objectKey])
    assert.match(result.version.objectKey, new RegExp(`^projects/${project.id}/materials/${result.material.id}/versions/${result.version.id}/[0-9a-f]{64}$`))
    assert.doesNotMatch(result.version.objectKey, /^https?:/)

    const duplicate = await env.material.registerMaterial(alice.identity, registration(project.id, { title: "重复登记" }), bytes)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.material.id, result.material.id)
    assert.equal(inner.keys().length, 1)
  } finally {
    await env.database.close()
  }
})

test("C2/AC-15: material access needs current project membership and edit for registration", async () => {
  const env = await setup()
  try {
    for (const username of ["alice", "bob", "carol"]) await env.create(username)
    const alice = await env.login("alice")
    const bob = await env.login("bob")
    const carol = await env.login("carol")
    const first = await env.projects.create(alice.identity, projectInput)
    const second = await env.projects.create(bob.identity, { ...projectInput, name: "第二项目" })
    const bytes = await docx(paragraph("跨项目材料。"))
    const result = await env.material.registerMaterial(alice.identity, registration(first.id), bytes)

    await assert.rejects(env.material.registerMaterial(alice.identity, registration(second.id), bytes), { code: "FORBIDDEN" })
    await assert.rejects(env.material.readMaterialVersion(bob.identity, { projectId: first.id, materialId: result.material.id, versionId: result.version.id }), { code: "FORBIDDEN" })
    await assert.rejects(env.material.readParseSnapshot(carol.identity, { projectId: first.id, snapshotId: result.snapshot.id }), { code: "FORBIDDEN" })

    await env.projects.addMember(alice.identity, first.id, { username: "bob", role: "viewer" })
    assert.equal((await env.material.listMaterials(bob.identity, first.id)).length, 1)
    await env.material.readParseSnapshot(bob.identity, { projectId: first.id, snapshotId: result.snapshot.id })
    await assert.rejects(env.material.registerMaterial(bob.identity, registration(first.id), await docx(paragraph("只读成员材料。"))), { code: "FORBIDDEN" })
    await env.projects.removeMember(alice.identity, first.id, bob.identity.account.id)
    await assert.rejects(env.material.readParseSnapshot(bob.identity, { projectId: first.id, snapshotId: result.snapshot.id }), { code: "FORBIDDEN" })
    await env.auth.logout(bob.token)
    await assert.rejects(env.material.readParseSnapshot(bob.identity, { projectId: first.id, snapshotId: result.snapshot.id }), { code: "UNAUTHENTICATED" })

    const fragments = await env.repository.fragments(result.snapshot.id)
    await assert.rejects(env.material.readSource(alice.identity, { projectId: first.id, snapshotId: result.snapshot.id, fragmentId: "00000000-0000-4000-8000-000000000000" }), { code: "NOT_FOUND" })
    await assert.rejects(env.material.readSource(alice.identity, { projectId: first.id, snapshotId: "00000000-0000-4000-8000-000000000000", fragmentId: fragments[0].id }), { code: "NOT_FOUND" })
    await assert.rejects(env.material.readMaterialVersion(alice.identity, { projectId: first.id, materialId: result.material.id, versionId: "00000000-0000-4000-8000-000000000000" }), { code: "NOT_FOUND" })
  } finally {
    await env.database.close()
  }
})

test("C2/AC-25: registration requires source authorization, purpose and bounded retention", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = await docx(paragraph("授权登记材料。"))
    const invalid: [unknown, string][] = [
      [registration(project.id, { processingAuthorized: false }), "INVALID_SOURCE"],
      [registration(project.id, { processingAuthorized: "yes" }), "INVALID_SOURCE"],
      [registration(project.id, { purpose: "" }), "INVALID_INPUT"],
      [registration(project.id, { sourceKind: "public" }), "INVALID_INPUT"],
      [registration(project.id, { sourceReference: "" }), "INVALID_INPUT"],
      [registration(project.id, { retentionUntil: "2028-01-01" }), "INVALID_INPUT"],
      [registration(project.id, { retentionUntil: "2026-10-27" }), "INVALID_INPUT"],
      [registration(project.id, { extra: true }), "INVALID_INPUT"],
      [registration("not-a-project"), "INVALID_INPUT"],
    ]
    for (const [body, code] of invalid) await assert.rejects(env.material.registerMaterial(alice.identity, body, bytes), { code })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id), png), { code: "INVALID_SOURCE" })
    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id), new TextEncoder().encode("plain text")), { code: "INVALID_SOURCE" })
    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id), new Uint8Array(20 * 1024 * 1024 + 1)), { code: "LIMIT_EXCEEDED" })
    assert.deepEqual((env.store as SyntheticObjectStore).keys(), [])
  } finally {
    await env.database.close()
  }
})

test("C2/AC-21/AC-24: image and textbox material never claims complete extracted text", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = await docx(paragraph("正文条款。") + "<w:p><w:r><w:drawing/></w:r></w:p>")
    const result = await env.material.registerMaterial(alice.identity, registration(project.id), bytes)
    assert.equal(result.coverage.status, "partial")
    const codes = result.coverage.findings.map(finding => finding.code)
    assert.ok(codes.includes("embedded_image"))
    assert.ok(codes.includes("ocr_unavailable"))
    const snapshot = await env.material.readParseSnapshot(alice.identity, { projectId: project.id, snapshotId: result.snapshot.id })
    assert.equal(snapshot.snapshot.coverage.status, "partial")
    assert.ok(snapshot.snapshot.coverage.findings.some(finding => finding.code === "ocr_unavailable"))
  } finally {
    await env.database.close()
  }
})

test("C2: reparse creates new snapshots and never replaces old references", async () => {
  const env = await setup()
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const first = await env.material.registerMaterial(alice.identity, registration(project.id), await docx(paragraph("第一版正文。")))
    const firstFragments = await env.repository.fragments(first.snapshot.id)
    const reparsed = await env.material.reparseMaterial(alice.identity, project.id, first.material.id)
    assert.equal(reparsed.snapshot.revision, 2)
    assert.notEqual(reparsed.snapshot.id, first.snapshot.id)
    const oldSnapshot = await env.material.readParseSnapshot(alice.identity, { projectId: project.id, snapshotId: first.snapshot.id })
    assert.equal(oldSnapshot.snapshot.revision, 1)
    const oldSource = await env.material.readSource(alice.identity, { projectId: project.id, snapshotId: first.snapshot.id, fragmentId: firstFragments[0].id })
    assert.equal(oldSource.fragment.text, "第一版正文。")
    assert.equal((await env.repository.fragments(first.snapshot.id)).length, 1)
    assert.equal((await env.repository.fragments(reparsed.snapshot.id)).length, 1)
    assert.equal((await env.repository.findSnapshot(project.id, first.snapshot.id))!.revision, 1)
    assert.equal((await env.repository.findMaterial(project.id, first.material.id))!.latestRevision, 2)
    assert.equal((await env.material.listMaterials(alice.identity, project.id))[0].snapshotId, reparsed.snapshot.id)

    const concurrent = await Promise.allSettled([
      env.material.reparseMaterial(alice.identity, project.id, first.material.id),
      env.material.reparseMaterial(alice.identity, project.id, first.material.id),
    ])
    const fulfilled = concurrent.filter(result => result.status === "fulfilled").length
    assert.equal(fulfilled, 1)
    const rejected = concurrent.find(result => result.status === "rejected") as PromiseRejectedResult
    assert.equal((rejected.reason as { code?: string }).code, "CONFLICT")
  } finally {
    await env.database.close()
  }
})

test("C2: failed parse keeps the original, records failed coverage and never fakes text", async () => {
  const inner = createSyntheticObjectStore()
  const env = await setup(inner)
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const scanned = await env.material.registerMaterial(alice.identity, registration(project.id), scannedPdf())
    assert.equal(scanned.coverage.status, "failed")
    assert.equal(scanned.coverage.textLength, 0)
    assert.deepEqual(await env.repository.fragments(scanned.snapshot.id), [])
    assert.ok(scanned.coverage.findings.some(finding => finding.code === "scanned_image"))
    const original = await env.material.readMaterialVersion(alice.identity, { projectId: project.id, materialId: scanned.material.id, versionId: scanned.version.id })
    assert.deepEqual(original.bytes, scannedPdf())

    const malformed = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9])
    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id, { title: "损坏文档" }), malformed), { code: "INVALID_SOURCE" })

    const blank = await docx("<w:p/>")
    const empty = await env.material.registerMaterial(alice.identity, registration(project.id, { title: "空白文档" }), blank)
    assert.equal(empty.coverage.status, "failed")
    assert.ok(empty.coverage.findings.some(finding => finding.code === "no_text"))
    const blankOriginal = await env.material.readMaterialVersion(alice.identity, { projectId: project.id, materialId: empty.material.id, versionId: empty.version.id })
    assert.deepEqual(blankOriginal.bytes, blank)

    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id, { title: "加密文件" }), encryptedPdf()), { code: "INVALID_SOURCE" })
    assert.equal(inner.keys().length, 2)
  } finally {
    await env.database.close()
  }
})

test("C2: failed storage writes leave no fake material and residual objects are recycled", async () => {
  const inner = createSyntheticObjectStore()
  const store = createFaultyObjectStore(inner, { delete: 1 })
  const env = await setup(store)
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const bytes = await docx(paragraph("残留回收材料。"))
    const originalCreate = env.repository.create
    env.repository.create = async () => { throw new Error("database unavailable") }
    await assert.rejects(env.material.registerMaterial(alice.identity, registration(project.id), bytes), { code: "SERVICE_UNAVAILABLE" })
    env.repository.create = originalCreate
    const residues = await env.repository.openResidues(10)
    assert.equal(residues.length, 1)
    assert.equal(inner.keys().length, 1)
    assert.equal((await env.material.listMaterials(alice.identity, project.id)).length, 0)
    const repaired = await env.material.repairResidues()
    assert.deepEqual(repaired, { resolved: 1, remaining: 0 })
    assert.deepEqual(inner.keys(), [])
    assert.deepEqual(await env.repository.openResidues(10), [])
  } finally {
    await env.database.close()
  }
})

test("C2: storage failures and missing originals do not alter saved snapshots", async () => {
  const inner = createSyntheticObjectStore()
  const env = await setup(inner)
  try {
    await env.create("alice")
    const alice = await env.login("alice")
    const project = await env.projects.create(alice.identity, projectInput)
    const result = await env.material.registerMaterial(alice.identity, registration(project.id), await docx(paragraph("原件读取失败测试。")))
    const key = inner.keys()[0]
    await inner.delete(key)
    await assert.rejects(env.material.readMaterialVersion(alice.identity, { projectId: project.id, materialId: result.material.id, versionId: result.version.id }), { code: "SERVICE_UNAVAILABLE" })
    assert.equal((await env.repository.fragments(result.snapshot.id)).length, 1)
    assert.equal((await env.repository.findSnapshot(project.id, result.snapshot.id))!.id, result.snapshot.id)
    await assert.rejects(env.material.reparseMaterial(alice.identity, project.id, result.material.id), { code: "SERVICE_UNAVAILABLE" })
    assert.equal((await env.repository.findMaterial(project.id, result.material.id))!.latestRevision, 1)
  } finally {
    await env.database.close()
  }
})
