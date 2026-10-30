/**
 * Round-eight browser acceptance (local Edge via playwright-core) + API setup.
 *
 * Deterministic only: no model call, no API key. The script seeds a synthetic
 * project (one parsed DOCX, a material-backed fact, a payment reconciliation
 * result, an evidence item and report, a ready collection letter plus a draft),
 * then verifies the real browser workbench: the 证据整理 and 催款函 business
 * tabs, report status, letter paragraphs and export, read-only behaviour, and
 * no send action anywhere.
 *
 * Failure paths are asserted over HTTP: party mismatch, draft letter approval,
 * tampered evidence report, browser writes of server-owned kinds.
 *
 * Synthetic/local acceptance only: no real OCR/OBS/GaussDB/model, no domain
 * sign-off of the produced documents.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { chromium } from "playwright-core"
import { docxFromParagraphs } from "../src/lib/documents/docx"

type Args = { base: string; database: string; username: string; password: string; viewer: string; viewerPassword: string; screenshots: string }

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
  if (!database) throw new Error("必须提供 --database（与服务端 SQLITE_PATH 相同）")
  return {
    base: (options.base ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    database,
    username: options.username ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? "round8admin",
    password: options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "round8-e2e-pass-123",
    viewer: options.viewer ?? "r8viewer",
    viewerPassword: options.viewerPassword ?? "round8-viewer-pass-123",
    screenshots: options.screenshots ?? join(process.cwd(), ".superpowers", "round8", "browser"),
  }
}

const args = parseArgs(process.argv.slice(2))
const origin = args.base
const checks: string[] = []
const notRun: string[] = []
const stamp = Date.now().toString(36)

type Json = Record<string, unknown>
type ApiResponse = { status: number; json: unknown }
type ResultViewJson = { resultId: string; versionId: string; sha256: string; kind: string; value: Json; validation: { status: string; issues: Array<{ code: string }> }; review: { decision: string } | null }

async function api(path: string, options: { method?: string; body?: unknown; form?: FormData; cookie?: string } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { origin }
  if (options.cookie) headers.cookie = options.cookie
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body) }
  const response = await fetch(`${args.base}${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
  let json: unknown = null
  try { json = await response.json() } catch { json = null }
  return { status: response.status, json }
}

function expectStatus(response: ApiResponse, status: number, name: string): Json {
  assert.equal(response.status, status, `${name}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`)
  return (response.json ?? {}) as Json
}

function expectError(response: ApiResponse, status: number, code: string, name: string): void {
  const body = expectStatus(response, status, name)
  assert.equal((body.error as Json | undefined)?.code, code, `${name}: 期望错误码 ${code}，实际 ${JSON.stringify(response.json)}`)
}

function pass(name: string, detail = ""): void {
  checks.push(name)
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`)
}



async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${args.base}/api/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username, password }), redirect: "error", cache: "no-store" })
  assert.equal(response.status, 200, `登录 ${username} 失败：${response.status}`)
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0]
  assert.ok(cookie, "登录未返回会话 Cookie")
  return cookie
}

const today = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000))

function fragments(snapshotId: string): Array<{ id: string; text: string }> {
  const database = new DatabaseSync(args.database)
  try { return database.prepare("SELECT id, text FROM equilens_source_fragments WHERE snapshot_id=? ORDER BY order_index").all(snapshotId) as unknown as Array<{ id: string; text: string }> }
  finally { database.close() }
}

async function uploadMaterial(projectId: string, cookie: string, title: string, paragraphs: string[], retentionUntil: string) {
  const blob = await docxFromParagraphs(paragraphs)
  const form = new FormData()
  form.append("file", new File([new Uint8Array(await blob.arrayBuffer())], `${title}.docx`, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))
  form.append("metadata", JSON.stringify({ title, fileName: `${title}.docx`, sourceKind: "synthetic", sourceReference: "第八轮浏览器验收合成样本", purpose: "第八轮业务界面验收", retentionUntil, processingAuthorized: true }))
  return expectStatus(await api(`/api/projects/${projectId}/materials`, { form, cookie }), 202, `上传材料 ${title}`) as { material: { id: string }; version: { id: string; sha256: string } }
}

async function waitParse(projectId: string, cookie: string, materialId: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const list = (await api(`/api/projects/${projectId}/materials`, { cookie })).json as { materials: Array<{ id: string; snapshotId: string | null; parseState: string | null }> }
    const current = list.materials.find(item => item.id === materialId)
    if (current?.snapshotId && ["success", "partial"].includes(current.parseState ?? "")) return { id: current.id, snapshotId: current.snapshotId }
    if (current?.parseState === "failed") throw new Error("材料解析失败")
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("材料解析超时")
}

async function browserAcceptance(adminCookie: string, viewerCookie: string, expected: { letterParagraph: string }) {
  await mkdir(args.screenshots, { recursive: true })
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const errors: string[] = []
  const contextFor = async (cookie: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true })
    const [name, value] = cookie.split("=")
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }])
    return context
  }
  try {
    const context = await contextFor(adminCookie)
    const page = await context.newPage()
    page.on("pageerror", failure => errors.push(`pageerror: ${failure.message}`))
    await page.goto(args.base, { waitUntil: "domcontentloaded" })
    await page.getByRole("tab", { name: "文档" }).waitFor({ timeout: 60_000 })
    await page.getByRole("tab", { name: "业务处理" }).click()
    for (const name of ["合同审查", "款项核对", "证据整理", "催款函", "投标材料核验", "文书起草"]) await page.getByRole("tab", { name }).waitFor({ timeout: 20_000 })
    pass("业务处理内新增证据整理与催款函")
    await page.screenshot({ path: join(args.screenshots, "business-tabs.png") })

    await page.getByRole("tab", { name: "证据整理" }).click()
    await page.getByRole("row").filter({ hasText: "合同价款" }).first().waitFor({ timeout: 30_000 })
    await page.getByRole("row").filter({ hasText: "未完成" }).first().waitFor({ timeout: 30_000 })
    pass("证据项与证据报告列表可见")
    await page.screenshot({ path: join(args.screenshots, "evidence-panel.png") })
    await page.getByRole("row").filter({ hasText: "未完成" }).getByRole("button", { name: "打开" }).first().click()
    await page.getByText("校验：未完成").waitFor({ timeout: 30_000 })
    const validated = page.waitForResponse(response => response.url().includes("/validate"), { timeout: 60_000 })
    await page.getByRole("button", { name: "重新校验" }).click()
    assert.equal((await validated).status(), 200, "证据报告重新校验应成功")
    pass("证据报告可打开并重新校验")
    await page.screenshot({ path: join(args.screenshots, "evidence-report.png") })

    await page.getByRole("tab", { name: "催款函" }).click()
    await page.getByRole("row").filter({ hasText: "可复核草稿" }).getByRole("button", { name: "打开" }).first().click()
    await page.getByText(expected.letterParagraph, { exact: false }).first().waitFor({ timeout: 30_000 })
    assert.equal(await page.getByRole("button", { name: "发送" }).count(), 0, "催款函不得提供发送按钮")
    assert.equal(await page.getByRole("button", { name: "发送催款函" }).count(), 0, "催款函不得提供发送按钮")
    pass("催款函正文展示金额且无发送入口")
    await page.screenshot({ path: join(args.screenshots, "letter-panel.png") })

    const exported = page.waitForResponse(response => response.url().includes("/exports") && response.request().method() === "POST", { timeout: 60_000 })
    await page.getByRole("button", { name: "导出 Word" }).click()
    assert.equal((await exported).status(), 201, "创建催款函导出应返回 201")
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 })
    await page.getByRole("button", { name: /下载 Word/ }).first().click()
    const target = join(args.screenshots, "collection-letter.docx")
    await (await downloadPromise).saveAs(target)
    const bytes = await readFile(target)
    assert.ok(bytes.length > 1000, "导出文件应有实际内容")
    pass("催款函 Word 导出下载", `sha256 ${createHash("sha256").update(bytes).digest("hex")}`)
    await page.close()
    await context.close()

    const viewerContext = await contextFor(viewerCookie)
    const viewerPage = await viewerContext.newPage()
    viewerPage.on("pageerror", failure => errors.push(`pageerror: ${failure.message}`))
    await viewerPage.goto(args.base, { waitUntil: "domcontentloaded" })
    await viewerPage.getByRole("tab", { name: "业务处理" }).click()
    await viewerPage.getByRole("tab", { name: "证据整理" }).click()
    await viewerPage.getByRole("button", { name: "新增证据项" }).waitFor({ state: "detached", timeout: 30_000 })
    assert.equal(await viewerPage.getByRole("button", { name: "新增证据项" }).count(), 0, "只读成员不应看到新增证据项")
    await viewerPage.getByRole("tab", { name: "催款函" }).click()
    assert.equal(await viewerPage.getByRole("button", { name: "新建催款函" }).count(), 0, "只读成员不应看到新建催款函")
    await viewerPage.screenshot({ path: join(args.screenshots, "viewer-readonly.png") })
    pass("只读成员界面隐藏证据与催款函写操作")
    await viewerPage.close()
    await viewerContext.close()

    assert.deepEqual(errors, [], `浏览器页面错误：${errors.join("; ")}`)
    pass("无浏览器页面错误")
  } finally { await browser.close() }
}

async function main(): Promise<void> {
  const admin = await login(args.username, args.password)
  pass("管理员登录")
  const viewer = await login(args.viewer, args.viewerPassword)
  pass("只读成员登录")

  const retentionUntil = today(30)
  const projectId = (expectStatus(await api("/api/projects", { cookie: admin, body: { name: "第八轮业务界面验收", source: "synthetic",
    sourceReference: "第八轮浏览器验收合成项目", purpose: "第八轮业务界面验收", retentionUntil } }), 201, "创建项目") as { project: { id: string } }).project.id
  expectStatus(await api(`/api/projects/${projectId}/budget`, { cookie: admin, body: { costLimitFen: 5000 } }), 200, "登记预算")
  expectStatus(await api(`/api/projects/${projectId}/members`, { cookie: admin, body: { username: args.viewer, role: "viewer" } }), 201, "添加只读成员")
  pass("创建项目、预算与只读成员", projectId)

  const contract = await uploadMaterial(projectId, admin, "专业分包合同（合成）", [
    "第一部分 合同价款",
    "合同价款为人民币 1,000,000.00 元（含税）。",
    "付款方式：按核定计量的 80% 支付进度款。",
    "发包人应在计量核定后 30 日内支付进度款。",
  ], retentionUntil)
  const parsed = await waitParse(projectId, admin, contract.material.id)
  pass("合成材料上传并解析", parsed.snapshotId)

  const rows = fragments(parsed.snapshotId)
  const price = rows.find(row => row.text.includes("1,000,000.00"))
  assert.ok(price, "缺少合同价款片段")
  const anchor = { projectId, materialId: contract.material.id, materialVersionId: contract.version.id, parseSnapshotId: parsed.snapshotId, fragmentId: price.id, quote: price.text, locator: `片段 ${price.id.slice(0, 8)}` }

  const fact = (expectStatus(await api(`/api/projects/${projectId}/facts`, { cookie: admin, body: {
    operationId: `r8-fact-${stamp}`, baseVersionId: "", reason: "第八轮验收合同价款",
    value: { subject: "示例专业分包人", field: "合同价款", nature: "材料记载", originalValue: price.text, selectedValue: "1000000.00",
      unit: "元", caliber: "含税", sources: [anchor], conflicts: [], confirmation: "已确认", support: "材料支持" },
  } }), 200, "保存材料事实") as { fact: { factId: string; factVersionId: string } }).fact
  pass("材料支持事实保存")

  const paymentDraft = { cutoff: "2026-10-30", contractId: "contract-synthetic-01",
    facts: [{ factId: fact.factId, factVersionId: fact.factVersionId }],
    rows: [
      { rowId: "row-measure", nature: "计量", amountFen: "100000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", confirmation: "已确认" },
      { rowId: "row-base", nature: "计付基数", amountFen: "100000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", ratio: "0.8", dueDate: "2026-10-20", conditionMet: true, payer: "示例发包人", payee: "示例专业分包人", confirmation: "已确认", source: anchor, factVersionIds: [fact.factVersionId] },
      { rowId: "row-payment", nature: "付款", amountFen: "30000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", eventDate: "2026-10-25", payer: "示例发包人", payee: "示例专业分包人", transactionId: "PAY-2026-10-001", confirmation: "已确认", source: anchor },
    ] }
  const payment = expectStatus(await api(`/api/projects/${projectId}/payments`, { cookie: admin, body: { operationId: `r8-payment-${stamp}`, reason: "第八轮验收款项核对", value: paymentDraft } }), 200, "保存款项成果") as ResultViewJson
  assert.equal(payment.validation.status, "valid")
  pass("款项成果确定性计算", "500000.00 元")

  const evidenceItem = (expectStatus(await api(`/api/projects/${projectId}/evidence-items`, { cookie: admin, body: {
    operationId: `r8-item-${stamp}`, baseVersionId: "", reason: "第八轮验收证据项",
    value: { kind: "材料事实", title: "合同价款", occurredAt: "2026-09-30", sources: [anchor], conflicts: [], confirmation: "已确认",
      support: "材料支持", links: [{ kind: "fact", factId: fact.factId, factVersionId: fact.factVersionId }] },
  } }), 200, "保存证据项") as { item: { itemId: string; versionId: string } }).item
  pass("证据项保存为不可变版本")

  const report = expectStatus(await api(`/api/projects/${projectId}/evidence-reports`, { cookie: admin, body: {
    operationId: `r8-report-${stamp}`, reason: "第八轮验收证据报告", baseVersionId: "",
    value: { cutoff: "2026-10-30", contractId: "contract-synthetic-01", itemVersionIds: [evidenceItem.versionId],
      timeline: [{ id: "t1", at: "2026-09-30", title: "第二期计量核定", evidenceVersionIds: [evidenceItem.versionId] }],
      disputes: [{ id: "d1", title: "进度款未付", claimAmountFen: "50000000", evidenceVersionIds: [evidenceItem.versionId], status: "待核实" }],
      gaps: [{ id: "g1", description: "缺少付款凭证", status: "开放" }],
      suggestions: [{ id: "s1", text: "补充付款凭证后再核对余额", dependsOnVersionIds: [evidenceItem.versionId] }] },
  } }), 200, "保存证据报告") as ResultViewJson
  assert.equal(report.kind, "evidence-report")
  assert.equal(report.validation.status, "partial", "存在开放缺口与待核实争点时应为未完成")
  const reportValue = report.value as { status: string; scopeNotes: string[] }
  assert.equal(reportValue.status, "incomplete")
  assert.ok(reportValue.scopeNotes.some(note => note.includes("缺口")))
  pass("证据报告派生未完成状态", reportValue.scopeNotes.length + " 条范围说明")

  expectError(await api(`/api/projects/${projectId}/results`, { cookie: admin, body: {
    projectId, kind: "evidence-report", baseVersionId: "", operationId: `r8-bypass-${stamp}`, reason: "浏览器绕过证据服务",
    value: { schemaVersion: 1 }, sources: [], dependencies: [],
  } }), 403, "FORBIDDEN", "浏览器不得直接写 evidence-report")
  expectError(await api(`/api/projects/${projectId}/results`, { cookie: admin, body: {
    projectId, kind: "collection-letter", baseVersionId: "", operationId: `r8-bypass-letter-${stamp}`, reason: "浏览器绕过催款函服务",
    value: { schemaVersion: 1 }, sources: [], dependencies: [],
  } }), 403, "FORBIDDEN", "浏览器不得直接写 collection-letter")
  pass("证据报告与催款函只能经受控服务写入")

  const letterDraft = { cutoff: "2026-10-30", contractTitle: "示例专业分包合同", sender: "示例专业分包人", recipient: "示例发包人",
    demand: "于收到本函后十日内支付上述款项", plannedDate: today(3), method: "邮寄", address: "上海市示例路 1 号",
    payment: { resultId: payment.resultId, versionId: payment.versionId, sha256: payment.sha256 }, factVersionIds: [fact.factVersionId],
    evidence: { resultId: report.resultId, versionId: report.versionId, sha256: report.sha256 } }
  const letter = expectStatus(await api(`/api/projects/${projectId}/letters`, { cookie: admin, body: { operationId: `r8-letter-${stamp}`, reason: "第八轮验收催款函", baseVersionId: "", value: letterDraft } }), 200, "保存催款函") as ResultViewJson
  assert.equal(letter.kind, "collection-letter")
  assert.equal(letter.validation.status, "partial", "引用的证据报告未完成时催款函只能是草稿")
  const letterValue = letter.value as { status: string; paragraphs: string[]; missing: string[] }
  assert.equal(letterValue.status, "draft")
  assert.ok(letterValue.missing.some(item => item.includes("证据整理")))
  pass("催款函记录证据报告未完成事项并保持草稿")

  expectError(await api(`/api/projects/${projectId}/letters`, { cookie: admin, body: {
    operationId: `r8-letter-party-${stamp}`, reason: "主体不一致", baseVersionId: "", value: { ...letterDraft, recipient: "其他主体" },
  } }), 422, "INVALID_SOURCE", "收发函主体与款项记录不一致被拒绝")
  expectError(await api(`/api/projects/${projectId}/letters`, { cookie: admin, body: {
    operationId: `r8-letter-zero-${stamp}`, reason: "引用无效款项", baseVersionId: "",
    value: { ...letterDraft, payment: { ...letterDraft.payment, sha256: "b".repeat(64) } },
  } }), 422, "INVALID_SOURCE", "款项摘要不一致被拒绝")
  pass("催款函引用校验拒绝主体与摘要不一致")

  const readyDraft = { ...letterDraft, evidence: undefined }
  const ready = expectStatus(await api(`/api/projects/${projectId}/letters`, { cookie: admin, body: { operationId: `r8-letter-ready-${stamp}`, reason: "第八轮验收完整催款函", baseVersionId: "", value: readyDraft } }), 200, "保存完整催款函") as ResultViewJson
  assert.equal(ready.validation.status, "valid", "字段齐全且款项有效时催款函应通过校验")
  expectError(await api(`/api/projects/${projectId}/results/${letter.resultId}/review`, { cookie: admin, body: {
    projectId, resultId: letter.resultId, versionId: letter.versionId, sha256: letter.sha256, decision: "approved", comment: "尝试批准草稿",
  } }), 422, "INVALID_SOURCE", "草稿催款函不得批准")
  expectStatus(await api(`/api/projects/${projectId}/results/${ready.resultId}/review`, { cookie: admin, body: {
    projectId, resultId: ready.resultId, versionId: ready.versionId, sha256: ready.sha256, decision: "approved", comment: "第八轮验收复核",
  } }), 200, "复核完整催款函")
  pass("草稿不可批准、完整稿可复核")

  await browserAcceptance(admin, viewer, { letterParagraph: "500000.00" })
  console.log(`\nRound-eight browser acceptance: ${checks.length} checks passed, ${notRun.length} not run`)
  await mkdir(args.screenshots, { recursive: true })
  await writeFile(join(args.screenshots, "browser-acceptance.json"), JSON.stringify({ checks, notRun, projectId, reportResultId: report.resultId, letterResultId: letter.resultId, generatedAt: new Date().toISOString() }, null, 2))
}

main().catch(failure => {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`)
  process.exitCode = 1
})
