import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { writeFile, mkdir } from "node:fs/promises"
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate"
import { blankDocx } from "../src/lib/documents/docx"
import { documentAnalysisMarkdown } from "../src/lib/document-agent/report"

// Explicit manual smoke test: real requests send synthetic content only. Use an isolated server/database.
const origin = new URL(process.argv[2] ?? "http://localhost:3002").origin
if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Only a local isolated test server is allowed")
let cookie = "", contextId = ""
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { Cookie: cookie } : {}),
    ...(contextId ? { "X-Document-Context": contextId } : {}), Origin: origin, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const assigned = response.headers.getSetCookie().find(value => value.startsWith("equilens_session="))
  if (assigned) cookie = assigned.split(";")[0]
  const value = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${value.code ?? ""} ${value.error ?? "request failed"}`)
  return value
}
const session = await request("/api/document-session"); contextId = session.contextId
const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
const materials = [
  "合成测试材料一：双方签认工程款对账确认单。合同：合成机电分包合同（付款人：合成甲公司，收款人：合成乙公司）。统计期间2026-10-01至2026-10-31，均为本期含税人民币金额。计量确认金额100万元，支付比例80%，已满足验收及发票条件，本期净应付80万元，于2026-10-31到期，无其他扣项；净应付已扣清全部约定扣抵，不能再乘比例。合成甲公司和合成乙公司于2026-10-31签认。",
  "合成测试材料二：银行付款回单。凭证号SYN-20261030-001，付款日期2026-10-30，付款人合成甲公司，收款人合成乙公司，用途为上述合成机电分包合同2026-10-01至2026-10-31本期含税工程款，人民币金额30万元，状态付款成功。",
  "合成测试材料三：双方收付款汇总确认表。截至2026-10-31，上述合同2026-10-01至2026-10-31本期全部应付、实付凭证已列明，净应付80万元；仅有回单SYN-20261030-001所列已付30万元，无其他付款、无争议扣抵、无未分配付款，双方合成甲公司及合成乙公司签认。",
]
files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", materials.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")))
const saved = await request("/api/documents", { title: "Agent 合成收付款测试", prompt: "", source: "imported", fileName: "synthetic-payments.docx", blob: Buffer.from(zipSync(files)).toString("base64"), retentionConsent: session.confirmation })
const configuration = (await request("/api/contract-reviews")).configuration
assert.ok(configuration.documentTasks.ready, configuration.documentTasks.error)
const records = []
const runDirectory = ".superpowers/document-agent-smoke/" + new Date().toISOString().replace(/[:.]/g, "-")
for (const task of ["payment-reconciliation", "evidence-organization", "collection-letter"] as const) {
  const created = await request("/api/contract-reviews", { task, asOf: "2026-10-31", documentId: saved.document.id, revisionId: saved.revision.id,
    context: { scene: "auto", role: "专业分包人", region: "" }, externalProcessingConsent: true, unreviewedMaterialsConsent: false,
    configurationId: configuration.documentTasks.configurationId,
    ...(task === "collection-letter" ? { paymentTaskId: records.find(record => record.task === "payment-reconciliation")!.taskId, evidenceTaskId: records.find(record => record.task === "evidence-organization")!.taskId,
      letterPlan: { sender: "合成乙公司", recipient: "合成甲公司", contractTitle: "合成机电分包合同", demand: "于收到本函后十日内核对并支付已到期款项", plannedDate: "2026-11-01", method: "专人递送", address: "合成测试地址" } } : {}),
  }, { "Idempotency-Key": randomUUID() })
  let detail = created
  const deadline = Date.now() + 360000
  while (["queued", "running"].includes(detail.state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    detail = await request("/api/contract-reviews/" + created.id)
  }
  const analysis = detail.result?.documentAnalysis
  records.push({ task, taskId: created.id, state: detail.state, calls: detail.callsUsed, tokens: detail.result?.usage?.totalTokens ?? null,
    error: detail.error, auditComplete: analysis?.audit.complete ?? false, rejected: analysis?.rejected ?? [], gaps: analysis?.extraction?.gaps ?? [],
    auditGaps: analysis?.audit.gaps ?? [], checks: analysis?.audit.checks ?? [], unpaidFen: analysis?.calculation?.unpaidFen ?? null })
  await mkdir(runDirectory, { recursive: true })
  await writeFile(runDirectory + "/results.json", JSON.stringify(records, null, 2))
  if (analysis) await writeFile(`${runDirectory}/${task}.md`, documentAnalysisMarkdown(analysis, saved.document.title, saved.revision.id, detail.result.input.parseSnapshotId))
  process.stdout.write(JSON.stringify(records.at(-1)) + "\n")
  assert.ok(analysis?.audit.complete, "Independent verification did not finish")
  assert.ok(detail.callsUsed <= 3)
  if (task === "payment-reconciliation") assert.equal(analysis.calculation?.unpaidFen, "50000000", "Synthetic debt should be exactly 500000 yuan")
  else if (task === "evidence-organization") assert.ok(analysis.extraction?.events.length)
  else {
    assert.ok(analysis.letter?.export, "Letter Word export should be saved")
    assert.match(analysis.letter.paragraphs.join(""), /500000\.00 元/)
    const response = await fetch(origin + "/api/contract-reviews/" + created.id + "/letter", { headers: { Cookie: cookie, "X-Document-Context": contextId } })
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(createHash("sha256").update(bytes).digest("hex"), analysis.letter.export.sha256)
    await writeFile(runDirectory + "/collection-letter.docx", bytes)
  }
  const before = detail.callsUsed
  const reopened = await request("/api/contract-reviews/" + created.id)
  assert.equal(reopened.callsUsed, before); assert.deepEqual(reopened.result, detail.result)
}
