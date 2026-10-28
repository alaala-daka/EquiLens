import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { chromium } from "playwright-core"
import type { RoundtripCapture } from "../../src/components/roundtrip-harness"

const base = process.env.EQUILENS_BASE_URL ?? "http://127.0.0.1:3000"
const directory = ".superpowers/previews/word-structures"
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")) as Array<{ id: string }>
mkdirSync(`${directory}/engine`, { recursive: true })
const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage()
const report: Array<{ id: string; ok: boolean; error?: string }> = []
for (const item of manifest) {
  try {
    await page.goto(`${base}/dev/roundtrip`)
    await page.setInputFiles('input[type="file"]', `${directory}/${item.id}.docx`)
    await page.waitForFunction(() => window.__roundtrip?.ready() === true, undefined, { timeout: 60000 })
    const captured: RoundtripCapture = await page.evaluate(() => window.__roundtrip!.capture())
    writeFileSync(`${directory}/engine/${item.id}.json`, JSON.stringify(captured.json, null, 2))
    if (captured.base64) writeFileSync(`${directory}/engine/${item.id}.export.docx`, Buffer.from(captured.base64, "base64"))
    report.push({ id: item.id, ok: Boolean(captured.base64), ...(captured.error ? { error: captured.error } : {}) })
  } catch (error) {
    report.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
writeFileSync(`${directory}/engine-report.json`, `${JSON.stringify(report, null, 2)}\n`)
await browser.close()
console.log(`Engine round-trip: ${report.filter(item => item.ok).length}/${report.length} exported`)
