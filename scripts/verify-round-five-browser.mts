/**
 * Round-five browser acceptance (local Edge via playwright-core) + API setup.
 *
 * Requires a running EquiLens server with a fresh SQLite database and
 * EQUILENS_SYNTHETIC_STORAGE=1, plus BOOTSTRAP_ADMIN_* for the first account.
 * The script seeds a synthetic project (materials/fields/requirement set/
 * comparison result) and a partial drafting draft over HTTP, then verifies the
 * actual browser workbench: project workspace tabs, in-tab business selector,
 * bid-verification workspace rendering (two status dimensions) and drafting
 * workspace rendering (待核对 draft). Screenshots go to .superpowers/round5/.
 *
 * Synthetic/local acceptance only: no real OCR/MaaS/OBS/GaussDB, no real
 * published rules, no domain template sign-off.
 */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { chromium } from "playwright-core"
import { docxFromParagraphs } from "../src/lib/documents/docx"

type Args = { base: string; database: string; username: string; password: string; screenshots: string }

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
  if (!database) throw new Error("必须提供 --database（与服务器 SQLITE_PATH 相同）")
  return {
    base: (options.base ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    database,
    username: options.username ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? "round4admin",
    password: options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "round4-e2e-pass-123",
    screenshots: options.screenshots ?? join(process.cwd(), ".superpowers", "round5"),
  }
}

const args = parseArgs(process.argv.slice(2))
const origin = args.base
const checks: string[] = []
let cookieHeader = ""

type ApiResponse = { status: number; json: unknown; headers: Headers }

async function api(path: string, options: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { origin, ...options.headers }
  if (cookieHeader) headers.cookie = cookieHeader
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body) }
  const response = await fetch(`${args.base}${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length && !cookieHeader) cookieHeader = setCookies[0].split(";")[0]
  let json: unknown = null
  try { json = await response.json() } catch { json = null }
  return { status: response.status, json, headers: response.headers }
}

function expectStatus(response: ApiResponse, status: number, name: string): Record<string, unknown> {
  assert.equal(response.status, status, `${name}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`)
  return response.json as Record<string, unknown>
}

function pass(name: string, detail = ""): void {
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`)
}

function shanghaiToday(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000))
}

function fragments(snapshotId: string): Array<{ id: string; text: string }> {
  const database = new DatabaseSync(args.database)
  try {
    return database.prepare("SELECT id, text FROM equilens_source_fragments WHERE snapshot_id=? ORDER BY order_index").all(snapshotId) as unknown as Array<{ id: string; text: string }>
  } finally { database.close() }
}

async function uploadMaterial(projectId: string, title: string, paragraphs: string[], retentionUntil: string) {
  const blob = await docxFromParagraphs(paragraphs)
  const form = new FormData()
  form.append("file", new File([new Uint8Array(await blob.arrayBuffer())], `${title}.docx`, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))
  form.append("metadata", JSON.stringify({ title, fileName: `${title}.docx`, sourceKind: "synthetic", sourceReference: "第五轮浏览器验收合成样本", purpose: "第五轮业务界面验收", retentionUntil, processingAuthorized: true }))
  const created = expectStatus(await api(`/api/projects/${projectId}/materials`, { form }), 202, `上传材料 ${title}`) as {
    material: { id: string }; version: { id: string; sha256: string }
  }
  return { material: created.material, version: created.version }
}

async function waitParse(projectId: string, materialId: string): Promise<{ id: string; snapshotId: string; parseState: string }> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const list = (await api(`/api/projects/${projectId}/materials`)).json as {
      materials: Array<{ id: string; snapshotId: string | null; parseState: string | null }>
    }
    const current = list.materials.find(item => item.id === materialId)
    if (current && current.snapshotId && ["success", "partial"].includes(current.parseState ?? "")) {
      return { id: current.id, snapshotId: current.snapshotId, parseState: current.parseState ?? "success" }
    }
    if (current && current.parseState === "failed") throw new Error("材料解析失败")
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("材料解析超时")
}

function findFragment(rows: Array<{ id: string; text: string }>, value: string) {
  const found = rows.find(row => row.text.includes(value))
  if (!found) throw new Error(`片段缺少 ${value}`)
  return found
}

async function browserAcceptance(): Promise<void> {
  await mkdir(args.screenshots, { recursive: true })
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const errors: string[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })
    const [name, value] = cookieHeader.split("=")
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }])
    const page = await context.newPage()
    page.on("pageerror", failure => errors.push(`pageerror: ${failure.message}`))
    await page.goto(args.base, { waitUntil: "domcontentloaded" })
    await page.getByRole("tab", { name: "文档" }).waitFor({ timeout: 60_000 })
    assert.ok(await page.getByRole("tab", { name: "业务处理" }).isVisible())
    assert.ok(await page.getByRole("tab", { name: "规范库" }).isVisible())
    pass("项目工作区顶层页签可见")
    await page.screenshot({ path: join(args.screenshots, "workspace-documents.png") })

    await page.getByRole("tab", { name: "业务处理" }).click()
    for (const name of ["合同审查", "投标材料核验", "文书起草"]) {
      await page.getByRole("tab", { name }).waitFor({ timeout: 20_000 })
    }
    pass("业务处理内业务选择可见")
    await page.screenshot({ path: join(args.screenshots, "business-tabs.png") })

    await page.getByRole("tab", { name: "投标材料核验" }).click()
    await page.getByRole("heading", { name: "投标材料核验" }).first().waitFor({ timeout: 30_000 })
    await page.getByRole("row").filter({ hasText: "核验结果" }).getByRole("button", { name: "查看" }).first().click()
    await page.getByText("材料检查与外部真实性两组状态独立", { exact: false }).first().waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(args.screenshots, "verification-workspace.png") })
    pass("投标材料核验工作区渲染两组状态")

    await page.getByRole("tab", { name: "文书起草" }).click()
    await page.getByRole("heading", { name: "文书草稿" }).first().waitFor({ timeout: 30_000 })
    await page.getByText("待核对", { exact: false }).first().waitFor({ timeout: 30_000 })
    await page.getByRole("row").filter({ hasText: "专业分包合同" }).getByRole("button", { name: "查看" }).first().click()
    await page.getByText("不能批准为完整复核成果", { exact: false }).first().waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(args.screenshots, "drafting-workspace.png") })
    pass("文书起草工作区渲染待核对草稿")

    assert.deepEqual(errors, [], `浏览器页面错误：${errors.join("; ")}`)
    pass("无浏览器页面错误")
  } finally {
    await browser.close()
  }
}

async function main(): Promise<void> {
  expectStatus(await api("/api/auth/login", { body: { username: args.username, password: args.password } }), 200, "管理员登录")
  pass("管理员登录")

  const retentionUntil = shanghaiToday(30)
  const projectId = (expectStatus(await api("/api/projects", { body: {
    name: "第五轮业务界面验收", source: "synthetic", sourceReference: "第五轮浏览器验收合成项目",
    purpose: "第五轮业务界面验收", retentionUntil,
  } }), 201, "创建项目") as { project: { id: string } }).project.id
  expectStatus(await api(`/api/projects/${projectId}/budget`, { body: { costLimitFen: 5000 } }), 200, "登记预算")
  pass("创建项目与预算", projectId)

  const tender = await uploadMaterial(projectId, "招标文件-资格要求", [
    "第一章 投标人资格要求", "投标人企业名称为示例建设集团有限公司。",
    "投标人统一社会信用代码为 91310000MA1FL0XXXX。",
  ], retentionUntil)
  const certificate = await uploadMaterial(projectId, "企业营业执照信息表", [
    "企业营业执照（副本）", "企业名称：示例建设集团有限公司", "统一社会信用代码：91310000MA1FL0XXXX",
  ], retentionUntil)
  const tenderParsed = await waitParse(projectId, tender.material.id)
  const certificateParsed = await waitParse(projectId, certificate.material.id)
  const tenderFragments = fragments(tenderParsed.snapshotId)
  const certificateFragments = fragments(certificateParsed.snapshotId)
  const subjectQuote = findFragment(tenderFragments, "示例建设集团有限公司")
  const codeQuote = findFragment(tenderFragments, "91310000MA1FL0XXXX")
  const subjectSource = findFragment(certificateFragments, "示例建设集团有限公司")
  const codeSource = findFragment(certificateFragments, "91310000MA1FL0XXXX")
  pass("合成材料上传并解析")

  expectStatus(await api(`/api/projects/${projectId}/materials/${certificate.material.id}/versions/${certificate.version.id}/fields`, { body: {
    operationId: `ui-fields-${Date.now()}`, reason: "浏览器验收人工登记", fields: [
      { fieldKey: "subject_name", valueText: "示例建设集团有限公司", subjectKey: "enterprise", sourceFragmentId: subjectSource.id },
      { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XXXX", subjectKey: "enterprise", sourceFragmentId: codeSource.id },
    ],
  } }), 200, "登记证照字段")
  pass("证照字段登记")

  const requirements = {
    schemaVersion: 1, status: "confirmed", rejected: [], warnings: [], errors: [],
    requirements: [
      { requirementId: "req-subject", subject: "投标人", quote: subjectQuote.text, materialVersionId: tender.version.id,
        source: { snapshotId: tenderParsed.snapshotId, fragmentId: subjectQuote.id }, addendum: { state: "none", note: "" },
        nature: "资格否决", field: "subject_name", operator: "eq", value: "示例建设集团有限公司", asOfRule: "not_applicable",
        materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "" },
      { requirementId: "req-code", subject: "投标人", quote: codeQuote.text, materialVersionId: tender.version.id,
        source: { snapshotId: tenderParsed.snapshotId, fragmentId: codeQuote.id }, addendum: { state: "none", note: "" },
        nature: "资格否决", field: "unified_social_credit_code", operator: "eq", value: "91310000MA1FL0XXXX", asOfRule: "not_applicable",
        materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "" },
    ],
  }
  const requirementSet = expectStatus(await api(`/api/projects/${projectId}/verifications/requirements`, { body: {
    baseVersionId: "", operationId: `ui-requirements-${Date.now()}`, reason: "浏览器验收要求集", value: requirements,
  } }), 200, "保存要求集")
  const submitted = expectStatus(await api("/api/tasks", { body: {
    kind: "bid-verification", projectId,
    refs: {
      materials: [{ materialVersionId: certificate.version.id, sha256: certificate.version.sha256 }],
      requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 }, externalRecords: [],
    },
    conditions: { asOf: shanghaiToday() },
  }, method: "POST", headers: { "Idempotency-Key": `ui-compare-${Date.now()}` } }), 202, "提交核验任务") as { task: { id: string } }
  let state = ""
  for (let attempt = 0; attempt < 240; attempt++) {
    const task = (await api(`/api/tasks/${submitted.task.id}`)).json as { state: string }
    state = task.state
    if (["success", "partial", "failed", "cancelled"].includes(state)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(state, "success", "核验任务应成功")
  pass("核验任务成功")

  const savedInput = expectStatus(await api(`/api/projects/${projectId}/drafting-inputs`, { body: {
    templateId: "specialty-subcontract-v1", baseVersionId: "", operationId: `ui-input-${Date.now()}`,
    fields: { "project.name": "第五轮浏览器验收项目", "project.location": "上海市" },
  } }), 200, "保存拟约定输入") as { input: { inputId: string; versionId: string; sha256: string } }
  const draft = expectStatus(await api(`/api/projects/${projectId}/drafts`, { body: {
    inputId: savedInput.input.inputId, versionId: savedInput.input.versionId,
    sha256: savedInput.input.sha256, operationId: `ui-draft-${Date.now()}`, reason: "浏览器验收生成草稿",
  } }), 200, "生成草稿") as { kind: string; validation: { status: string } }
  assert.equal(draft.kind, "specialty-subcontract")
  assert.equal(draft.validation.status, "partial")
  pass("生成 partial 草稿")

  await browserAcceptance()
  console.log(`\nRound-five browser acceptance: ${checks.length} checks passed`)
  const summary = { checks, projectId, generatedAt: new Date().toISOString() }
  await writeFile(join(args.screenshots, "browser-acceptance.json"), JSON.stringify(summary, null, 2))
}

main().catch(failure => {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`)
  process.exitCode = 1
})
