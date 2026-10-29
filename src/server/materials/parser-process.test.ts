import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../lib/documents/docx"
import { parseMaterial } from "./parse"
import { parseInSubprocess } from "./parser-process"

test("C2b subprocess preserves DOCX parse result", async () => {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合同价款</w:t></w:r></w:p></w:body></w:document>')
  const input = { bytes: zipSync(files), format: "docx" as const }
  assert.deepEqual(await parseInSubprocess(input), parseMaterial(input))
})
test("C2b rejects malformed ZIP", async () => {
  await assert.rejects(parseInSubprocess({ bytes: new Uint8Array([80,75,3,4]), format: "docx" }), /INVALID_SOURCE/)
})
test("C2b abort and deadline terminate an unresponsive worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "material-worker-"))
  const workerPath = join(dir, "worker.cjs")
  await writeFile(workerPath, "setInterval(() => {}, 1000)")
  const input = { bytes: new Uint8Array([1]), format: "pdf" as const }
  try {
    await assert.rejects(parseInSubprocess(input, { workerPath, timeoutMs: 20 }), /PARSE_TIMEOUT/)
    const controller = new AbortController()
    const running = parseInSubprocess(input, { workerPath, signal: controller.signal })
    controller.abort()
    await assert.rejects(running, /PARSE_ABORTED/)
    await assert.rejects(parseInSubprocess(input, { signal: controller.signal }), /PARSE_ABORTED/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test("C2b worker does not inherit parent environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "material-env-"))
  const workerPath = join(dir, "worker.cjs")
  await writeFile(workerPath, 'process.on("message", () => process.send({ok: false, code: process.env.C2B_TEST_SECRET ? "ENV_LEAK" : "ENV_EMPTY"}))')
  try {
    await assert.rejects(parseInSubprocess({ bytes: new Uint8Array([1]), format: "pdf" }, { workerPath }), /ENV_EMPTY/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})



test("C2b PDF subprocess preserves extracted text and coverage", async () => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", "<< /Length 28 >>\nstream\nBT (Contract amount) Tj ET\nendstream"]
  const bytes = Buffer.from("%PDF-1.4\n" + objects.map((body, i) => `${i+1} 0 obj\n${body}\nendobj\n`).join("") + "trailer\n<< /Root 1 0 R >>\n%%EOF\n")
  const input = { bytes, format: "pdf" as const }
  assert.deepEqual(await parseInSubprocess(input), parseMaterial(input))
})
