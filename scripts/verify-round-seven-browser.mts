/**
 * Round-seven browser acceptance (local Edge via playwright-core) + API setup.
 *
 * Requires a running EquiLens server with a fresh SQLite database,
 * EQUILENS_SYNTHETIC_STORAGE=1, BOOTSTRAP_ADMIN_* and one pre-created viewer
 * account (scripts/manage-account.mts create). The script seeds a synthetic
 * project (two parsed DOCX materials, project facts, a payment reconciliation
 * result) over HTTP, then verifies the real browser workbench: the 款项核对
 * business tab, the 项目事实 / 款项表 regions, the deterministic calculation,
 * re-validation and Word export, plus the contract-review workspace.
 *
 * Model-backed paths (fact preparation task, contract-review machine result)
 * only run with --model; otherwise they are recorded as not run instead of
 * being replaced with synthetic results.
 *
 * Failure paths are asserted separately: invalid citation, cross-project
 * source, stale base version, unconfirmed fact, read-only member, bypassing the
 * machine-result requirement for contract-review.
 *
 * Synthetic/local acceptance only: no real OCR/OBS/GaussDB/published-rule
 * sign-off, no domain acceptance of the produced documents.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { chromium } from "playwright-core"
import { docxFromParagraphs } from "../src/lib/documents/docx"

type Args = {
  base: string
  database: string
  username: string
  password: string
  viewer: string
  viewerPassword: string
  screenshots: string
  model: boolean
}

function parseArgs(argv: string[]): Args {
  const options: Record<string, string> = {}
  let model = false
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith("--")) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      if (key === "--model") { model = true; continue }
      throw new Error(`缺少参数值：${key}`)
    }
    options[key.slice(2)] = value
    index++
  }
  const database = options.database ?? process.env.SQLITE_PATH
  if (!database) throw new Error("必须提供 --database（与服务端 SQLITE_PATH 相同）")
  return {
    base: (options.base ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    database,
    username: options.username ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? "round7admin",
    password: options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "round7-e2e-pass-123",
    viewer: options.viewer ?? "r7viewer",
    viewerPassword: options.viewerPassword ?? "round7-viewer-pass-123",
    screenshots: options.screenshots ?? join(process.cwd(), ".superpowers", "round7", "browser"),
    model,
  }
}

const args = parseArgs(process.argv.slice(2))
const origin = args.base
const checks: string[] = []
const notRun: string[] = []
const stamp = Date.now().toString(36)

type Json = Record<string, unknown>

type ApiResponse = { status: number; json: unknown; headers: Headers }

async function api(path: string, options: { method?: string; body?: unknown; form?: FormData; cookie?: string; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { origin, ...options.headers }
  if (options.cookie) headers.cookie = options.cookie
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body) }
  const response = await fetch(`${args.base}${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
  let json: unknown = null
  try { json = await response.json() } catch { json = null }
  return { status: response.status, json, headers: response.headers }
}

function expectStatus(response: ApiResponse, status: number, name: string): Json {
  assert.equal(response.status, status, `${name}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`)
  return (response.json ?? {}) as Json
}

function expectError(response: ApiResponse, status: number, code: string, name: string): void {
  const body = expectStatus(response, status, name)
  const error = body.error as Json | undefined
  assert.equal(error?.code, code, `${name}: 期望错误码 ${code}，实际 ${JSON.stringify(response.json)}`)
}

function pass(name: string, detail = ""): void {
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`)
}

function skip(name: string, reason: string): void {
  notRun.push(`${name}: ${reason}`)
  console.log(`NOT RUN ${name} · ${reason}`)
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${args.base}/api/auth/login`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username, password }), redirect: "error", cache: "no-store",
  })
  assert.equal(response.status, 200, `登录 ${username} 失败：${response.status} ${await response.text()}`)
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0]
  assert.ok(cookie, "登录未返回会话 Cookie")
  return cookie
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

function findFragment(rows: Array<{ id: string; text: string }>, value: string) {
  const found = rows.find(row => row.text.includes(value))
  if (!found) throw new Error(`片段缺少 ${value}`)
  return found
}

async function uploadMaterial(projectId: string, cookie: string, title: string, paragraphs: string[], retentionUntil: string) {
  const blob = await docxFromParagraphs(paragraphs)
  const form = new FormData()
  form.append("file", new File([new Uint8Array(await blob.arrayBuffer())], `${title}.docx`, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))
  form.append("metadata", JSON.stringify({ title, fileName: `${title}.docx`, sourceKind: "synthetic", sourceReference: "第七轮浏览器验收合成样本", purpose: "第七轮业务界面验收", retentionUntil, processingAuthorized: true }))
  const created = expectStatus(await api(`/api/projects/${projectId}/materials`, { form, cookie }), 202, `上传材料 ${title}`) as {
    material: { id: string }; version: { id: string; sha256: string }
  }
  return created
}

async function waitParse(projectId: string, cookie: string, materialId: string): Promise<{ id: string; snapshotId: string; parseState: string }> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const list = (await api(`/api/projects/${projectId}/materials`, { cookie })).json as {
      materials: Array<{ id: string; snapshotId: string | null; parseState: string | null }>
    }
    const current = list.materials.find(item => item.id === materialId)
    if (current?.snapshotId && ["success", "partial"].includes(current.parseState ?? "")) return { id: current.id, snapshotId: current.snapshotId, parseState: current.parseState ?? "success" }
    if (current?.parseState === "failed") throw new Error("材料解析失败")
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("材料解析超时")
}

type FactView = {
  factId: string; factVersionId: string; version: number; field: string
  confirmation: string; evidenceStatus: string; support: string; supersedesVersionId?: string
}

type ResultViewJson = {
  resultId: string; versionId: string; sha256: string; kind: string
  value: Json; validation: { status: string; issues: Array<{ code: string; message: string }> }
  review: { decision: string } | null
}

async function browserAcceptance(projectId: string, adminCookie: string, viewerCookie: string, expected: { contractReview: boolean; candidates: boolean }) {
  await mkdir(args.screenshots, { recursive: true })
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const errors: string[] = []
  const attach = (page: import("playwright-core").Page) => { page.on("pageerror", failure => errors.push(`pageerror: ${failure.message}`)) }
  const cookiePair = (cookie: string) => { const [name, value] = cookie.split("="); return { name, value } }
  const contextFor = async (cookie: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true })
    const { name, value } = cookiePair(cookie)
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }])
    return context
  }
  try {
    const context = await contextFor(adminCookie)
    const page = await context.newPage()
    attach(page)
    await page.goto(args.base, { waitUntil: "domcontentloaded" })
    await page.getByRole("tab", { name: "文档" }).waitFor({ timeout: 60_000 })
    await page.getByRole("tab", { name: "业务处理" }).click()
    for (const name of ["合同审查", "款项核对", "投标材料核验", "文书起草"]) await page.getByRole("tab", { name }).waitFor({ timeout: 20_000 })
    pass("业务处理内业务选择含款项核对")
    await page.screenshot({ path: join(args.screenshots, "business-tabs.png") })

    await page.getByRole("tab", { name: "款项核对" }).click()
    await page.getByRole("tab", { name: "项目事实" }).waitFor({ timeout: 30_000 })
    await page.getByRole("tab", { name: "款项表" }).waitFor({ timeout: 30_000 })
    pass("款项核对内项目事实与款项表区域可见")

    await page.getByRole("tab", { name: "项目事实" }).click()
    await page.getByRole("row").filter({ hasText: "计付基数" }).getByText("材料支持").waitFor({ timeout: 30_000 })
    await page.getByRole("row").filter({ hasText: "付款条件" }).getByText("材料冲突").waitFor({ timeout: 30_000 })
    const manualRow = page.getByRole("row").filter({ hasText: "合同金额" }).first()
    await manualRow.getByText("2", { exact: true }).waitFor({ timeout: 30_000 })
    pass("项目事实列表显示材料支持、材料冲突与更正版本")
    await page.screenshot({ path: join(args.screenshots, "project-facts.png") })

    if (expected.candidates) {
      await page.getByText("候选事实").first().waitFor({ timeout: 30_000 })
      await page.getByRole("button", { name: "确认或更正" }).first().click()
      await page.getByRole("heading", { name: "确认事实" }).waitFor({ timeout: 30_000 })
      await page.getByRole("button", { name: "保存事实" }).waitFor({ timeout: 30_000 })
      await page.screenshot({ path: join(args.screenshots, "fact-candidate-dialog.png") })
      await page.getByRole("button", { name: "放弃更改" }).click()
      pass("机器候选事实可打开确认对话框")
    } else {
      skip("机器候选事实确认对话框", "事实准备任务未产生候选成果")
    }

    await page.getByRole("tab", { name: "款项表" }).click()
    await page.getByRole("row").filter({ hasText: "有条件测算" }).getByRole("button", { name: "打开" }).click()
    await page.getByText("已到期未付：500000.00 元").waitFor({ timeout: 30_000 })
    await page.getByText("校验：通过").waitFor({ timeout: 30_000 })
    pass("款项成果展示确定性计算结果与校验状态")
    await page.screenshot({ path: join(args.screenshots, "payment-reconciliation.png") })

    const validated = page.waitForResponse(response => response.url().includes("/validate"), { timeout: 60_000 })
    await page.getByRole("button", { name: "重新校验" }).click()
    assert.equal((await validated).status(), 200, "重新校验请求应成功")
    await page.getByText("校验：通过").waitFor({ timeout: 30_000 })
    pass("浏览器重新校验通过")

    const exported = page.waitForResponse(response => response.url().includes("/exports") && response.request().method() === "POST", { timeout: 60_000 })
    await page.getByRole("button", { name: "导出 Word" }).click()
    assert.equal((await exported).status(), 201, "创建导出应返回 201")
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 })
    await page.getByRole("button", { name: /下载 Word/ }).first().click()
    const target = join(args.screenshots, "payment-reconciliation.docx")
    await (await downloadPromise).saveAs(target)
    const bytes = await readFile(target)
    assert.ok(bytes.length > 1000, "导出文件应有实际内容")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    pass("款项 Word 导出下载", `sha256 ${sha256}`)

    await page.getByRole("tab", { name: "合同审查" }).click()
    await page.getByRole("heading", { name: "审查材料与条件" }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(args.screenshots, "contract-review.png") })
    if (expected.contractReview) {
      await page.getByRole("row").getByRole("button", { name: "查看" }).first().click()
      const decision = page.locator("select[id$='-decision']").first()
      await decision.waitFor({ timeout: 30_000 })
      await decision.selectOption("驳回")
      await page.locator("textarea[id^='revision-reason-']").fill("浏览器验收人工处理决定")
      const revisionSaved = page.waitForResponse(response => response.url().includes("/revisions") && response.request().method() === "POST", { timeout: 60_000 })
      await page.getByRole("button", { name: "保存修订版本" }).click()
      assert.equal((await revisionSaved).status(), 200, "保存审查修订应成功")
      await page.getByText("修订版本已保存", { exact: false }).first().waitFor({ timeout: 30_000 })
      assert.equal(await decision.inputValue(), "驳回", "保存后应保留所选处理决定")
      pass("合同审查工作区保存处理决定修订")
      await page.screenshot({ path: join(args.screenshots, "contract-review-decisions.png") })
    } else {
      pass("合同审查工作区可打开")
      skip("合同审查人工修订界面", "无 contract-review 机器成果且未启用 --model")
    }
    await page.close()
    await context.close()

    const viewerContext = await contextFor(viewerCookie)
    const viewerPage = await viewerContext.newPage()
    attach(viewerPage)
    await viewerPage.goto(args.base, { waitUntil: "domcontentloaded" })
    await viewerPage.getByRole("tab", { name: "业务处理" }).click()
    await viewerPage.getByRole("tab", { name: "款项核对" }).click()
    await viewerPage.getByRole("tab", { name: "项目事实" }).waitFor({ timeout: 30_000 })
    assert.equal(await viewerPage.getByRole("button", { name: "新增事实" }).count(), 0, "只读成员不应看到新增事实")
    await viewerPage.getByRole("tab", { name: "款项表" }).click()
    assert.equal(await viewerPage.getByRole("button", { name: "保存款项表" }).count(), 0, "只读成员不应看到保存款项表")
    await viewerPage.screenshot({ path: join(args.screenshots, "viewer-readonly.png") })
    pass("只读成员界面隐藏写操作")
    await viewerPage.close()
    await viewerContext.close()

    assert.deepEqual(errors, [], `浏览器页面错误：${errors.join("; ")}`)
    pass("无浏览器页面错误")
  } finally {
    await browser.close()
  }
}

async function main(): Promise<void> {
  const admin = await login(args.username, args.password)
  pass("管理员登录")
  const viewer = await login(args.viewer, args.viewerPassword)
  pass("只读成员登录")

  const retentionUntil = shanghaiToday(30)
  const projectId = (expectStatus(await api("/api/projects", { cookie: admin, body: {
    name: "第七轮业务界面验收", source: "synthetic", sourceReference: "第七轮浏览器验收合成项目",
    purpose: "第七轮业务界面验收", retentionUntil,
  } }), 201, "创建项目") as { project: { id: string } }).project.id
  expectStatus(await api(`/api/projects/${projectId}/budget`, { cookie: admin, body: { costLimitFen: 5000 } }), 200, "登记预算")
  expectStatus(await api(`/api/projects/${projectId}/members`, { cookie: admin, body: { username: args.viewer, role: "viewer" } }), 201, "添加只读成员")
  pass("创建项目、预算与只读成员", projectId)

  const contract = await uploadMaterial(projectId, admin, "专业分包合同（合成）", [
    "第一部分 合同价款",
    "合同价款为人民币 1,000,000.00 元（含税）。",
    "付款方式：按核定计量的 80% 支付进度款，剩余款项竣工结算后支付。",
    "第二部分 付款条件",
    "发包人应在计量核定后 30 日内支付进度款。",
  ], retentionUntil)
  const record = await uploadMaterial(projectId, admin, "进度计量与付款记录（合成）", [
    "第二期计量核定金额为人民币 1,000,000.00 元。",
    "发包人已于 2026-10-25 支付进度款 300,000.00 元，凭证号 PAY-2026-10-001。",
  ], retentionUntil)
  const contractParsed = await waitParse(projectId, admin, contract.material.id)
  const recordParsed = await waitParse(projectId, admin, record.material.id)
  pass("合成材料上传并解析", `${contractParsed.parseState}/${recordParsed.parseState}`)

  const contractFragments = fragments(contractParsed.snapshotId)
  const recordFragments = fragments(recordParsed.snapshotId)
  const priceFragment = findFragment(contractFragments, "1,000,000.00")
  const ratioFragment = findFragment(contractFragments, "80%")
  const dueFragment = findFragment(contractFragments, "30 日内支付进度款")
  const measureFragment = findFragment(recordFragments, "第二期计量")
  const paymentFragment = findFragment(recordFragments, "PAY-2026-10-001")

  const anchor = (material: { material: { id: string }; version: { id: string } }, parsed: { snapshotId: string }, fragment: { id: string; text: string }) => ({
    projectId, materialId: material.material.id, materialVersionId: material.version.id,
    parseSnapshotId: parsed.snapshotId, fragmentId: fragment.id, quote: fragment.text, locator: `片段 ${fragment.id.slice(0, 8)}`,
  })
  const priceAnchor = anchor(contract, contractParsed, priceFragment)
  const ratioAnchor = anchor(contract, contractParsed, ratioFragment)
  const dueAnchor = anchor(contract, contractParsed, dueFragment)
  const measureAnchor = anchor(record, recordParsed, measureFragment)
  const paymentAnchor = anchor(record, recordParsed, paymentFragment)

  const saveFact = (body: Json, cookie = admin) => api(`/api/projects/${projectId}/facts`, { cookie, body })

  // B1a: 人工陈述事实 + 更正版本
  const manual = expectStatus(await saveFact({
    operationId: `r7-manual-${stamp}`, baseVersionId: "", reason: "浏览器验收人工陈述合同金额",
    value: {
      subject: "示例专业分包人", field: "合同金额", nature: "人工陈述", originalValue: "1,000,000.00 元",
      selectedValue: "1000000.00", unit: "元", caliber: "含税", sources: [], conflicts: [],
      confirmation: "已确认", support: "仅人工陈述",
    },
  }), 200, "保存人工陈述事实") as { fact: FactView }
  assert.equal(manual.fact.version, 1, "首次保存应为版本 1")
  assert.equal(manual.fact.evidenceStatus, "仅人工陈述")
  pass("人工陈述事实保存为不可变版本")

  const corrected = expectStatus(await saveFact({
    operationId: `r7-manual-fix-${stamp}`, factId: manual.fact.factId, baseVersionId: manual.fact.factVersionId,
    reason: "浏览器验收更正合同金额口径",
    value: {
      subject: "示例专业分包人", field: "合同金额", nature: "人工陈述", originalValue: "1,000,000.00 元",
      selectedValue: "1000000.00", unit: "元", caliber: "含税（业主核定）", sources: [], conflicts: [],
      confirmation: "已确认", support: "仅人工陈述",
    },
  }), 200, "更正事实") as { fact: FactView }
  assert.equal(corrected.fact.version, 2, "更正应生成版本 2")
  assert.equal(corrected.fact.supersedesVersionId, manual.fact.factVersionId, "新版本应引用上一版本")
  pass("事实更正生成版本链")

  expectError(await saveFact({
    operationId: `r7-stale-${stamp}`, factId: manual.fact.factId, baseVersionId: manual.fact.factVersionId,
    reason: "浏览器验收过期基础版本",
    value: {
      subject: "示例专业分包人", field: "合同金额", nature: "人工陈述", selectedValue: "1000000.00",
      sources: [], conflicts: [], confirmation: "已确认", support: "仅人工陈述",
    },
  }), 409, "CONFLICT", "过期基础版本被拒绝")
  pass("事实更正基础版本冲突返回 409")

  expectError(await saveFact({
    operationId: `r7-badquote-${stamp}`, baseVersionId: "", reason: "浏览器验收错误引文",
    value: {
      subject: "示例专业分包人", field: "合同金额", nature: "材料记载", sources: [{ ...priceAnchor, quote: "合同中不存在的引文" }],
      conflicts: [], confirmation: "已确认", support: "材料支持",
    },
  }), 422, "INVALID_SOURCE", "引文不符被拒绝")
  pass("事实引文不符返回 422")

  expectError(await saveFact({
    operationId: `r7-crossproject-${stamp}`, baseVersionId: "", reason: "浏览器验收跨项目来源",
    value: {
      subject: "示例专业分包人", field: "合同金额", nature: "材料记载", sources: [{ ...priceAnchor, projectId: "00000000-0000-4000-8000-000000000000" }],
      conflicts: [], confirmation: "已确认", support: "材料支持",
    },
  }), 422, "INVALID_SOURCE", "跨项目来源被拒绝")
  pass("事实跨项目来源返回 422")

  // B1a：材料支持事实、材料冲突事实、未确认事实
  const baseFact = (expectStatus(await saveFact({
    operationId: `r7-base-${stamp}`, baseVersionId: "", reason: "浏览器验收材料记载计付基数",
    value: {
      subject: "示例专业分包人", field: "计付基数", nature: "材料记载", originalValue: "第二期计量核定金额为人民币 1,000,000.00 元。",
      selectedValue: "1000000.00", unit: "元", caliber: "含税", sources: [measureAnchor], conflicts: [],
      confirmation: "已确认", support: "材料支持",
    },
  }), 200, "保存材料记载事实") as { fact: FactView }).fact
  assert.equal(baseFact.evidenceStatus, "材料支持")

  const conflictFact = (expectStatus(await saveFact({
    operationId: `r7-conflict-${stamp}`, baseVersionId: "", reason: "浏览器验收付款条件材料冲突",
    value: {
      subject: "示例专业分包人", field: "付款条件", nature: "材料记载", originalValue: "按核定计量的 80% 支付进度款",
      selectedValue: "80%", unit: "%", caliber: "含税", sources: [ratioAnchor], conflicts: [dueAnchor],
      confirmation: "已确认", support: "材料冲突",
    },
  }), 200, "保存材料冲突事实") as { fact: FactView }).fact
  assert.equal(conflictFact.evidenceStatus, "材料冲突", "冲突来源不得被确认清除")
  pass("事实材料冲突保留且确认不清除")

  const unconfirmedFact = (expectStatus(await saveFact({
    operationId: `r7-unconfirmed-${stamp}`, baseVersionId: "", reason: "浏览器验收未确认到期日",
    value: {
      subject: "示例专业分包人", field: "到期日", nature: "材料记载", originalValue: "计量核定后 30 日内",
      selectedValue: "2026-10-20", unit: "日", caliber: "含税", sources: [dueAnchor], conflicts: [],
      confirmation: "未确认", support: "材料支持",
    },
  }), 200, "保存未确认事实") as { fact: FactView }).fact
  assert.equal(unconfirmedFact.confirmation, "未确认")

  const listed = expectStatus(await api(`/api/projects/${projectId}/facts`, { cookie: admin }), 200, "读取事实列表") as { facts: FactView[] }
  assert.equal(listed.facts.length, 4, "应返回四条最新事实")
  assert.ok(listed.facts.every(fact => fact.version === 1 || fact.field === "合同金额"))
  const history = expectStatus(await api(`/api/projects/${projectId}/facts/${manual.fact.factId}`, { cookie: admin }), 200, "读取事实历史") as { versions: FactView[] }
  assert.deepEqual(history.versions.map(version => version.version), [2, 1], "历史应按版本降序")
  pass("事实列表与历史可读")

  expectStatus(await api(`/api/projects/${projectId}/facts`, { cookie: viewer }), 200, "只读成员读取事实")
  expectError(await saveFact({
    operationId: `r7-viewer-${stamp}`, baseVersionId: "", reason: "只读成员写入",
    value: { field: "合同金额", nature: "人工陈述", selectedValue: "1", sources: [], conflicts: [], confirmation: "已确认", support: "仅人工陈述" },
  }, viewer), 403, "FORBIDDEN", "只读成员保存事实被拒绝")
  expectError(await api(`/api/projects/${projectId}/facts`, { headers: { cookie: "" } }), 401, "UNAUTHENTICATED", "未登录读取事实被拒绝")
  pass("事实读权限与写权限分离")

  // B3a: 款项核对确定性计算
  const paymentValue = {
    cutoff: "2026-10-30", contractId: "contract-synthetic-01",
    facts: [{ factId: baseFact.factId, factVersionId: baseFact.factVersionId }],
    rows: [
      { rowId: "row-measure", nature: "计量", amountFen: "100000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", confirmation: "已确认", source: measureAnchor, note: "第二期计量核定" },
      { rowId: "row-base", nature: "计付基数", amountFen: "100000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", ratio: "0.8", dueDate: "2026-10-20", conditionMet: true, payer: "示例发包人", payee: "示例专业分包人", confirmation: "已确认", source: priceAnchor, factVersionIds: [baseFact.factVersionId] },
      { rowId: "row-payment", nature: "付款", amountFen: "30000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", eventDate: "2026-10-25", payer: "示例发包人", payee: "示例专业分包人", transactionId: "PAY-2026-10-001", confirmation: "已确认", source: paymentAnchor },
    ],
  }
  const saved = expectStatus(await api(`/api/projects/${projectId}/payments`, { cookie: admin, body: { operationId: `r7-payment-${stamp}`, reason: "浏览器验收款项核对", value: paymentValue } }), 200, "保存款项核对表") as ResultViewJson
  assert.equal(saved.kind, "payment-reconciliation")
  assert.equal(saved.validation.status, "valid", "确定可计算成果应为 valid")
  const calculation = (saved.value as Json).calculation as Json
  assert.equal(calculation.netDueFen, "80000000", "计付基数 80% 应按比例计算")
  assert.equal(calculation.paidFen, "30000000")
  assert.equal(calculation.unpaidFen, "50000000", "已到期未付应为 500,000.00 元")
  pass("款项核对保存并确定性计算 500000.00 元", String(calculation.formula))

  expectError(await api(`/api/projects/${projectId}/payments`, { cookie: admin, body: {
    operationId: `r7-payment-tamper-${stamp}`, reason: "浏览器验收篡改计算结果",
    value: { ...paymentValue, calculation: { netDueFen: "99000000", paidFen: "0", unpaidFen: "99000000", formula: "伪造" } },
  } }), 400, "INVALID_INPUT", "浏览器提交计算结果被拒绝")
  pass("浏览器不得提交合计或计算结果")

  expectError(await api(`/api/projects/${projectId}/payments`, { cookie: admin, body: {
    operationId: `r7-payment-unconfirmed-${stamp}`, reason: "浏览器验收未确认事实",
    value: {
      ...paymentValue,
      facts: [{ factId: unconfirmedFact.factId, factVersionId: unconfirmedFact.factVersionId }],
      rows: [{ ...paymentValue.rows[1], factVersionIds: [unconfirmedFact.factVersionId] }, paymentValue.rows[2]],
    },
  } }), 422, "INVALID_SOURCE", "未确认事实被拒绝")
  pass("款项引用未确认事实返回 422")

  expectError(await api(`/api/projects/${projectId}/payments`, { cookie: viewer, body: { operationId: `r7-payment-viewer-${stamp}`, reason: "只读成员", value: paymentValue } }), 403, "FORBIDDEN", "只读成员保存款项表被拒绝")
  pass("只读成员不能保存款项表")

  const draft = expectStatus(await api(`/api/projects/${projectId}/payments`, { cookie: admin, body: {
    operationId: `r7-payment-draft-${stamp}`, reason: "浏览器验收未确认款项行",
    value: { ...paymentValue, rows: paymentValue.rows.map(row => ({ ...row, confirmation: "未确认" })) },
  } }), 200, "保存草案款项表") as ResultViewJson
  assert.equal((draft.value as Json).status, "draft", "未确认行只能形成草案")
  assert.equal(draft.validation.status, "partial")
  assert.ok(draft.validation.issues.some(issue => issue.code === "PAYMENT_DRAFT"))
  expectError(await api(`/api/projects/${projectId}/results/${draft.resultId}/review`, { cookie: admin, body: {
    projectId, resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, decision: "approved", comment: "尝试批准草案",
  } }), 422, "INVALID_SOURCE", "草案不得批准")
  pass("未确认款项只形成草案且不能批准")

  const revised = expectStatus(await api(`/api/projects/${projectId}/payments/${saved.resultId}/revisions`, { cookie: admin, body: {
    operationId: `r7-payment-revision-${stamp}`, reason: "浏览器验收修订备注", baseVersionId: saved.versionId,
    value: { ...paymentValue, rows: paymentValue.rows.map(row => row.rowId === "row-payment" ? { ...row, note: "凭证已核对" } : row) },
  } }), 200, "保存款项修订") as ResultViewJson
  assert.notEqual(revised.versionId, saved.versionId, "修订应生成新版本")
  assert.equal(revised.review, null, "修订后复核状态应重置")

  expectError(await api(`/api/projects/${projectId}/payments/${saved.resultId}/revisions`, { cookie: admin, body: {
    operationId: `r7-payment-stale-${stamp}`, reason: "浏览器验收过期版本", baseVersionId: saved.versionId,
    value: paymentValue,
  } }), 409, "CONFLICT", "过期基础版本修订被拒绝")
  pass("款项修订另存新版本并拒绝过期基础版本")

  const validated = expectStatus(await api(`/api/projects/${projectId}/results/${revised.resultId}/validate`, { cookie: admin, body: { projectId, resultId: revised.resultId, versionId: revised.versionId, sha256: revised.sha256 } }), 200, "重新校验款项成果") as { status: string }
  assert.equal(validated.status, "valid")
  const approved = expectStatus(await api(`/api/projects/${projectId}/results/${revised.resultId}/review`, { cookie: admin, body: {
    projectId, resultId: revised.resultId, versionId: revised.versionId, sha256: revised.sha256, decision: "approved", comment: "浏览器验收复核",
  } }), 200, "复核款项成果") as { review: Json }
  assert.equal(approved.review.decision, "approved")
  const exported = expectStatus(await api(`/api/projects/${projectId}/results/${revised.resultId}/exports`, { cookie: admin, body: { versionId: revised.versionId, sha256: revised.sha256 } }), 201, "创建款项导出") as { exportId: string }
  const download = await fetch(`${args.base}/api/projects/${projectId}/results/${revised.resultId}/exports/${exported.exportId}/content`, { headers: { origin, cookie: admin }, redirect: "error", cache: "no-store" })
  assert.equal(download.status, 200, "导出下载应成功")
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.ok(bytes.length > 1000, "导出文件应有实际内容")
  pass("款项导出复核闭环", `sha256 ${createHash("sha256").update(bytes).digest("hex")}`)

  // B2b: 机器成果不可由浏览器新建
  expectError(await api(`/api/projects/${projectId}/results`, { cookie: admin, body: {
    projectId, kind: "contract-review", baseVersionId: "", operationId: `r7-review-bypass-${stamp}`, reason: "浏览器验收绕过机器成果",
    value: { schemaVersion: 1, findings: [], coverage: [] }, sources: [], dependencies: [],
  } }), 403, "FORBIDDEN", "浏览器新建合同审查成果被拒绝")
  pass("合同审查不允许人工新建成果")

  let contractReview: ResultViewJson | null = null
  let factCandidates = false
  if (!args.model) {
    skip("事实准备任务（B1a 机器候选）", "未启用 --model")
    skip("合同审查人工修订（B2b）", "无 contract-review 机器成果且未启用 --model")
  } else {
    const submitted = expectStatus(await api("/api/tasks", { cookie: admin, method: "POST", headers: { "Idempotency-Key": `r7-analysis-${stamp}` }, body: {
      kind: "document-analysis", projectId,
      refs: { materials: [{ materialVersionId: contract.version.id, sha256: contract.version.sha256 }] },
      conditions: { asOf: shanghaiToday(), externalProcessingConsent: true },
    } }), 202, "提交事实准备任务") as { task: { id: string } }
    const analysis = await waitTask(admin, submitted.task.id)
    if (analysis.state === "success" || analysis.state === "partial") {
      factCandidates = true
      pass("事实准备任务完成", `${analysis.state} · 调用 ${String(analysis.callsUsed ?? "?")} 次`)
    } else skip("事实准备任务（B1a 机器候选）", `任务终态 ${analysis.state}：${String(analysis.error ?? "未提供")}`)

    const reviewSubmitted = expectStatus(await api("/api/tasks", { cookie: admin, method: "POST", headers: { "Idempotency-Key": `r7-review-${stamp}` }, body: {
      kind: "contract-review", projectId,
      refs: { materials: [{ materialVersionId: contract.version.id, sha256: contract.version.sha256 }] },
      conditions: { scene: "mep-sub-2026", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true, asOf: shanghaiToday() },
    } }), 202, "提交合同审查任务") as { task: { id: string } }
    const reviewTask = await waitTask(admin, reviewSubmitted.task.id)
    if (reviewTask.state === "success" || reviewTask.state === "partial") {
      const results = expectStatus(await api(`/api/projects/${projectId}/results`, { cookie: admin }), 200, "读取成果列表") as unknown as ResultViewJson[]
      contractReview = results.filter(result => result.kind === "contract-review").at(-1) ?? null
      assert.ok(contractReview, "审查任务成功但未找到机器成果")
    } else skip("合同审查人工修订（B2b）", `审查任务终态 ${reviewTask.state}`)
  }

  if (contractReview) {
    const value = contractReview.value as Json & { findings?: Array<Json> }
    const findings = Array.isArray(value.findings) ? value.findings : []
    if (!findings.length) {
      skip("合同审查人工修订（B2b）", "机器成果未发现任何发现项")
    } else {
      const decisions = findings.map((finding, index) => ({
        findingIndex: index, ruleId: String(finding.ruleId), decision: index === 0 ? "采纳" : "修订",
        reason: "浏览器验收人工处理决定", ...(index === 0 ? {} : { editedSuggestion: "浏览器验收修订建议" }),
      }))
      const revision = expectStatus(await api(`/api/projects/${projectId}/results/${contractReview.resultId}/revisions`, { cookie: admin, body: {
        projectId, resultId: contractReview.resultId, kind: "contract-review", baseVersionId: contractReview.versionId,
        operationId: `r7-review-revision-${stamp}`, reason: "浏览器验收处理决定", value: { ...value, findingDecisions: decisions }, sources: [], dependencies: [],
      } }), 200, "保存审查修订") as ResultViewJson
      assert.equal((revision.value as Json).findingDecisions instanceof Array, true)
      assert.equal(revision.review, null, "修订后复核状态应重置")
      pass("合同审查处理决定另存新版本")

      expectError(await api(`/api/projects/${projectId}/results/${contractReview.resultId}/revisions`, { cookie: admin, body: {
        projectId, resultId: contractReview.resultId, kind: "contract-review", baseVersionId: revision.versionId,
        operationId: `r7-review-tamper-${stamp}`, reason: "浏览器验收改写机器发现",
        value: { ...value, findings: [{ ...findings[0], quote: "被改写的引文" }, ...findings.slice(1)], findingDecisions: decisions }, sources: [], dependencies: [],
      } }), 400, "INVALID_INPUT", "改写机器发现被拒绝")
      pass("合同审查机器字段不可改写")
    }
  }

  await browserAcceptance(projectId, admin, viewer, { contractReview: contractReview !== null, candidates: factCandidates })
  console.log(`\nRound-seven browser acceptance: ${checks.length} checks passed, ${notRun.length} not run`)
  const summary = { checks, notRun, projectId, paymentResultId: saved.resultId, model: args.model, generatedAt: new Date().toISOString() }
  await mkdir(args.screenshots, { recursive: true })
  await writeFile(join(args.screenshots, "browser-acceptance.json"), JSON.stringify(summary, null, 2))
}

async function waitTask(cookie: string, taskId: string): Promise<{ state: string; callsUsed?: number; error?: string }> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const task = (await api(`/api/tasks/${taskId}`, { cookie })).json as { state?: string; callsUsed?: number; error?: { message?: string } | string }
    const state = task.state ?? ""
    if (["success", "partial", "failed", "cancelled"].includes(state)) return { state, callsUsed: task.callsUsed, error: typeof task.error === "string" ? task.error : task.error?.message }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return { state: "timeout" }
}

main().catch(failure => {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`)
  process.exitCode = 1
})
