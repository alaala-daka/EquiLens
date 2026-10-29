/**
 * Round-four C4 server-level acceptance (no external OCR/model required).
 *
 * Runs against a locally started EquiLens server with a fresh SQLite database and
 * the development file object store enabled (EQUILENS_SYNTHETIC_STORAGE=1). It
 * proves the project HTTP path end to end:
 * login → project → material upload/parse → manual certificate fields →
 * server-owned requirement-set save → deterministic bid-verification task →
 * validation → human approval → versioned Word export/download.
 * Negative paths: browser cannot write the requirement set/result directly,
 * deterministic comparison rejects a missing material as 材料缺失, image upload
 * is refused while OCR is unverified, and certificate-ocr submission is 503.
 *
 * Synthetic fixtures and evidence only: this is not a real OCR/MaaS/GaussDB or
 * legal-quality acceptance.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-bid-verification.mts --database data/e2e.sqlite
 * Options: --base http://127.0.0.1:3000 --username round4admin --password ...
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { strFromU8, unzipSync } from "fflate"
import { docxFromParagraphs } from "../src/lib/documents/docx"

type Args = { base: string; database: string; username: string; password: string }

function parseArgs(argv: string[]): Args {
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith("--")) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`缺少参数值：${key}`)
    options[key.slice(2)] = value
    index++
  }
  const database = options.database ?? process.env.SQLITE_PATH
  if (!database) throw new Error("必须提供 --database（与服务器 SQLITE_PATH 相同的 SQLite 文件）")
  return {
    base: (options.base ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    database,
    username: options.username ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? "round4admin",
    password: options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "round4-e2e-pass-123",
  }
}

const args = parseArgs(process.argv.slice(2))
const origin = args.base
let cookie = ""
let projectId = ""
let tender: MaterialView | null = null
let certificate: MaterialView | null = null
let requirementSet: ResultView | null = null
let verification: ResultView | null = null
const checks: string[] = []

type MaterialView = { id: string; versionId: string; sha256: string; title: string; format: string; parseState: string | null; snapshotId: string | null }
type ResultView = { projectId: string; resultId: string; versionId: string; sha256: string; kind: string; validation: { status: string }; review: { decision: string } | null }
type FragmentRow = { id: string; snapshot_id: string; text: string }

type ApiResponse = { status: number; headers: Headers; json: unknown; bytes: Uint8Array | null }

async function api(path: string, options: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string>; bytes?: boolean } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { origin, ...options.headers }
  if (cookie) headers.cookie = cookie
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${args.base}${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length) cookie = setCookies[0].split(";")[0]
  const bytes = options.bytes ? new Uint8Array(await response.arrayBuffer()) : null
  let json: unknown = null
  if (!options.bytes) { try { json = await response.json() } catch { json = null } }
  return { status: response.status, headers: response.headers, json, bytes }
}

function pass(name: string, detail = ""): void {
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`)
}

function expectStatus(response: ApiResponse, status: number, name: string): unknown {
  assert.equal(response.status, status, `${name}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`)
  return response.json
}

function errorMessage(json: unknown): string {
  const value = json as { error?: { message?: unknown } } | null
  return typeof value?.error?.message === "string" ? value.error.message : ""
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function shanghaiToday(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

async function uploadMaterial(title: string, paragraphs: string[], retentionUntil: string): Promise<MaterialView> {
  const blob = await docxFromParagraphs(paragraphs)
  const form = new FormData()
  form.append("file", new File([new Uint8Array(await blob.arrayBuffer())], `${title}.docx`, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))
  form.append("metadata", JSON.stringify({
    title, fileName: `${title}.docx`, sourceKind: "synthetic", sourceReference: "第四轮合成验收样本",
    purpose: "C4 投标材料核验服务端闭环验收", retentionUntil, processingAuthorized: true,
  }))
  const created = expectStatus(await api(`/api/projects/${projectId}/materials`, { form }), 202, `上传材料 ${title}`) as { material: MaterialView; version: { id: string; sha256: string } }
  return { ...created.material, versionId: created.version.id, sha256: created.version.sha256, parseState: null, snapshotId: null }
}

async function waitForParse(material: MaterialView, name: string): Promise<MaterialView> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const list = (await api(`/api/projects/${projectId}/materials`)).json as { materials: MaterialView[] }
    const current = list.materials.find(item => item.id === material.id)
    if (current && current.snapshotId && (current.parseState === "success" || current.parseState === "partial")) {
      pass(`${name} 解析完成`, `${current.parseState} ${current.snapshotId}`)
      return current
    }
    if (current && current.parseState === "failed") throw new Error(`${name} 解析失败`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${name} 解析超时`)
}

function fragments(project: string, snapshotId: string): FragmentRow[] {
  const database = new DatabaseSync(args.database)
  try {
    return database.prepare("SELECT id, snapshot_id, text FROM equilens_source_fragments WHERE project_id=? AND snapshot_id=? ORDER BY order_index").all(project, snapshotId) as unknown as FragmentRow[]
  } finally {
    database.close()
  }
}

function fragmentContaining(rows: FragmentRow[], value: string): FragmentRow {
  const found = rows.find(row => row.text.includes(value))
  if (!found) throw new Error(`快照中找不到包含「${value}」的片段`)
  return found
}

async function main(): Promise<void> {
  // 1. Login (bootstrap admin created by the server's first start).
  expectStatus(await api("/api/auth/login", { body: { username: args.username, password: args.password } }), 200, "管理员登录")
  pass("管理员登录")

  // 2. Project + budget.
  const retentionUntil = shanghaiToday(30)
  const project = expectStatus(await api("/api/projects", { body: {
    name: "第四轮投标核验闭环", source: "synthetic", sourceReference: "第四轮合成验收项目",
    purpose: "C4 投标材料核验服务端闭环验收", retentionUntil,
  } }), 201, "创建项目") as { project: { id: string } }
  projectId = project.project.id
  pass("创建项目", projectId)
  expectStatus(await api(`/api/projects/${projectId}/budget`, { body: { costLimitFen: 5000 } }), 200, "登记项目预算")
  pass("登记项目预算")

  // 3. Upload a tender document and a certificate-information sheet, wait for parsing.
  tender = await uploadMaterial("招标文件-资格要求", [
    "第一章 投标人资格要求",
    "投标人须具有独立法人资格，并提交有效的企业营业执照。",
    "投标人企业名称为示例建设集团有限公司。",
    "投标人统一社会信用代码为 91310000MA1FL0XXXX。",
  ], retentionUntil)
  pass("上传招标文件")
  certificate = await uploadMaterial("企业营业执照信息表", [
    "企业营业执照（副本）",
    "企业名称：示例建设集团有限公司",
    "统一社会信用代码：91310000MA1FL0XXXX",
    "注册资本：人民币5000万元",
    "营业期限：2020年1月1日至2035年12月31日",
  ], retentionUntil)
  pass("上传证照材料")
  tender = await waitForParse(tender, "招标文件")
  certificate = await waitForParse(certificate, "证照材料")
  const tenderFragments = fragments(projectId, tender.snapshotId!)
  const certificateFragments = fragments(projectId, certificate.snapshotId!)
  const subjectQuote = fragmentContaining(tenderFragments, "示例建设集团有限公司")
  const codeQuote = fragmentContaining(tenderFragments, "91310000MA1FL0XXXX")
  const subjectSource = fragmentContaining(certificateFragments, "示例建设集团有限公司")
  const codeSource = fragmentContaining(certificateFragments, "91310000MA1FL0XXXX")

  // 4. Register manual certificate fields (server verifies verbatim same-version sources).
  expectStatus(await api(`/api/projects/${projectId}/materials/${certificate.id}/versions/${certificate.versionId}/fields`, { body: {
    operationId: `e2e-fields-${Date.now()}`,
    reason: "合成验收人工登记证照字段",
    fields: [
      { fieldKey: "subject_name", valueText: "示例建设集团有限公司", subjectKey: "enterprise", sourceFragmentId: subjectSource.id },
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XXXX", subjectKey: "enterprise", sourceFragmentId: codeSource.id },
    ],
  } }), 200, "登记证照字段")
  pass("登记证照字段")

  // 5. Save a confirmed requirement set through the server-owned path.
  const requirements = {
    schemaVersion: 1,
    status: "confirmed",
    requirements: [
      { requirementId: "req-subject", subject: "投标人", quote: subjectQuote.text, materialVersionId: tender.versionId,
        source: { snapshotId: tender.snapshotId, fragmentId: subjectQuote.id }, addendum: { state: "none", note: "" },
        nature: "资格否决", field: "subject_name", operator: "eq", value: "示例建设集团有限公司", asOfRule: "not_applicable",
        materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "" },
      { requirementId: "req-code", subject: "投标人", quote: codeQuote.text, materialVersionId: tender.versionId,
        source: { snapshotId: tender.snapshotId, fragmentId: codeQuote.id }, addendum: { state: "none", note: "" },
        nature: "资格否决", field: "unified_social_credit_code", operator: "eq", value: "91310000MA1FL0XXXX", asOfRule: "not_applicable",
        materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "" },
    ],
    rejected: [],
    warnings: [],
    errors: [],
  }
  // The generic browser result write must not create requirement sets.
  const forbidden = await api(`/api/projects/${projectId}/results`, { body: {
    kind: "bid-requirements", baseVersionId: "", operationId: `e2e-forged-${Date.now()}`, reason: "伪造",
    value: requirements, sources: [], dependencies: [],
  } })
  assert.equal(forbidden.status, 403, `普通成果写入应被拒绝，实际 ${forbidden.status}`)
  pass("普通成果接口不能写要求集")
  requirementSet = expectStatus(await api(`/api/projects/${projectId}/verifications/requirements`, { body: {
    baseVersionId: "", operationId: `e2e-requirements-${Date.now()}`, reason: "合成验收人工确认要求集", value: requirements,
  } }), 200, "服务端保存要求集") as ResultView
  projectId = requirementSet.projectId
  pass("服务端保存要求集", `${requirementSet.resultId}/${requirementSet.versionId}`)
  assert.equal(requirementSet.validation.status, "valid", "要求集应通过服务端复核")

  // 6. Deterministic comparison task (no model/OCR call).
  const submitted = expectStatus(await api("/api/tasks", { body: {
    kind: "bid-verification", projectId,
    refs: {
      materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
      requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
      externalRecords: [],
    },
    conditions: { asOf: shanghaiToday() },
  }, headers: { "Idempotency-Key": `e2e-compare-${Date.now()}` } }), 202, "提交核验任务") as { task: { id: string; state: string } }
  pass("提交核验任务", submitted.task.id)
  let task = submitted.task
  for (let attempt = 0; attempt < 240; attempt++) {
    const current = (await api(`/api/tasks/${task.id}`)).json as { id: string; state: string; errorCode: string | null }
    task = current
    if (["success", "partial", "failed", "cancelled"].includes(task.state)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(task.state, "success", `核验任务应成功，实际 ${task.state}`)
  pass("核验任务成功")

  // 7. Read, validate, approve and export the machine result.
  const results = (await api(`/api/projects/${projectId}/results`)).json as ResultView[]
  verification = results.filter(item => item.kind === "bid-verification").at(-1) ?? null
  assert.ok(verification, "缺少 bid-verification 成果")
  pass("读取核验成果", verification.resultId)
  const value = (await api(`/api/projects/${projectId}/results/${verification.resultId}?versionId=${verification.versionId}`)).json as { value: { status: string; items: Array<{ materialCheck: string }>; coverage: { pending: number } } }
  assert.ok(value.value.items.length === 2, "核验结果应包含两条要求")
  assert.ok(value.value.items.every(item => item.materialCheck === "满足材料要求"), `材料检查应全部满足：${JSON.stringify(value.value.items)}`)
  assert.equal(value.value.coverage.pending, 0, "不应有未确认材料检查")
  pass("两组状态与材料检查正确")
  const validated = expectStatus(await api(`/api/projects/${projectId}/results/${verification.resultId}/validate`, { body: { versionId: verification.versionId, sha256: verification.sha256 } }), 200, "重验成果") as { status: string }
  assert.equal(validated.status, "valid", "核验成果应为 valid")
  pass("成果校验 valid")
  expectStatus(await api(`/api/projects/${projectId}/results/${verification.resultId}/review`, { body: {
    versionId: verification.versionId, sha256: verification.sha256, decision: "approved", comment: "第四轮合成闭环验收",
  } }), 200, "人工复核")
  pass("人工复核 approved")
  const exported = expectStatus(await api(`/api/projects/${projectId}/results/${verification.resultId}/exports`, { body: {
    versionId: verification.versionId, sha256: verification.sha256,
  } }), 201, "创建 Word 导出") as { exportId: string; sha256: string }
  assert.equal(exported.sha256, verification.sha256, "导出应固定所选成果版本的摘要")
  const download = await api(`/api/projects/${projectId}/results/${verification.resultId}/exports/${exported.exportId}/content`, { bytes: true })
  assert.equal(download.status, 200, "导出下载应成功")
  assert.match(download.headers.get("content-type") ?? "", /wordprocessingml/, "导出下载应为 DOCX 类型")
  assert.ok(download.bytes && download.bytes.byteLength > 0, "导出下载不应为空")
  const downloadSha = sha256(download.bytes!)
  const again = await api(`/api/projects/${projectId}/results/${verification.resultId}/exports/${exported.exportId}/content`, { bytes: true })
  assert.ok(again.bytes && sha256(again.bytes) === downloadSha, "重复下载应返回同一份不可变字节")
  const documentXml = unzipSync(download.bytes!)["word/document.xml"]
  const documentText = documentXml ? strFromU8(documentXml) : ""
  assert.ok(documentText.includes("确定性比较结果"), "导出正文应说明确定性比较来源")
  assert.ok(documentText.includes("外部真实性"), "导出正文应包含外部真实性状态")
  pass("Word 导出与重复下载字节一致", downloadSha)

  // 8. List/detail API and generic result-write negative path.
  const list = (await api(`/api/projects/${projectId}/verifications`)).json as { items: Array<{ kind: string }> }
  assert.ok(list.items.some(item => item.kind === "bid-requirements") && list.items.some(item => item.kind === "bid-verification"), "列表应包含两类核验成果")
  pass("核验列表包含两类成果")
  const detail = (await api(`/api/projects/${projectId}/verifications/${verification.resultId}`)).json as { result: { stale?: { hint: string | null } } }
  assert.ok(detail.result, "详情应可读取")
  pass("核验详情可读取")
  const forgedVerification = await api(`/api/projects/${projectId}/results`, { body: {
    kind: "bid-verification", baseVersionId: "", operationId: `e2e-forged-compare-${Date.now()}`, reason: "伪造",
    value: { schemaVersion: 1 }, sources: [], dependencies: [],
  } })
  assert.equal(forgedVerification.status, 403, `普通成果写入应被拒绝，实际 ${forgedVerification.status}`)
  pass("普通成果接口不能写核验成果")

  // 9. OCR fail-closed negative paths.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89])
  const imageForm = new FormData()
  imageForm.append("file", new File([png], "certificate.png", { type: "image/png" }))
  imageForm.append("metadata", JSON.stringify({ title: "证照图片", fileName: "certificate.png", sourceKind: "synthetic", sourceReference: "第四轮合成验收样本", purpose: "C4 OCR 边界验收", retentionUntil, processingAuthorized: true }))
  const imageUpload = await api(`/api/projects/${projectId}/materials`, { form: imageForm })
  assert.ok(imageUpload.status >= 400 && imageUpload.status < 500, `未验证 OCR 时图片应被拒绝，实际 ${imageUpload.status}`)
  assert.ok(/OCR|证照/.test(errorMessage(imageUpload.json)), `图片拒绝文案应说明 OCR 边界：${errorMessage(imageUpload.json)}`)
  pass("未验证 OCR 时图片上传被拒绝")
  const ocrTask = await api("/api/tasks", { body: {
    kind: "certificate-ocr", projectId,
    refs: { materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }] },
    conditions: { certificateKind: "enterprise_license", externalProcessingConsent: true },
  }, headers: { "Idempotency-Key": `e2e-ocr-${Date.now()}` } })
  assert.equal(ocrTask.status, 503, `未注册 OCR 执行器时提交应 503，实际 ${ocrTask.status}`)
  pass("certificate-ocr 提交 503")

  console.log(`\nC4 server closed loop: ${checks.length} checks passed`)
}

main().catch(failure => {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`)
  process.exitCode = 1
})
