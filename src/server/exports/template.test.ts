import assert from "node:assert/strict"
import { test } from "node:test"
import { unzipSync, strFromU8 } from "fflate"
import { productionExportTemplates } from "./template"
import { BusinessError } from "../projects/errors"
import { ExportRepository } from "./repository"
import { ExportService } from "./service"
import { partialResult, projectId, setupReview, successResult, testAuthorizer, testIdentity, validRunnerInput } from "../reviews/test-fixtures"

test("A4c export templates: contract-review-report-v1 is registered and unknown kinds stay unavailable", () => {
  const templates = productionExportTemplates()
  assert.equal(templates.require("contract-review").version, "contract-review-report-v1")
  assert.throws(() => templates.require("test"), { code: "SERVICE_UNAVAILABLE" })
  assert.throws(() => templates.require("docx"), { code: "SERVICE_UNAVAILABLE" })
})

test("A4c export templates: the report body carries AI/unsigned markers, coverage and per-finding location plus basis", () => {
  const template = productionExportTemplates().require("contract-review")
  const lines = template.paragraphs(successResult(validRunnerInput()))
  const text = lines.join("\n")
  assert.match(text, /项目合同审查报告/)
  assert.match(text, /AI 辅助生成的机器成果/)
  assert.match(text, /依据尚未签核/)
  assert.match(text, /审查模式：开发调试，依据未核对/)
  assert.match(text, /检查覆盖：/)
  assert.match(text, /逐条发现（1 项）/)
  assert.match(text, /位置：第 1 段/)
  assert.match(text, /依据：/)
  assert.match(text, /复核状态：待人工复核/)
  assert.match(text, /不代表合同没有风险/)
  const partial = template.paragraphs(partialResult(validRunnerInput())).join("\n")
  assert.match(partial, /待核实/)
  assert.match(partial, /检查覆盖：/)
  assert.throws(() => template.paragraphs(null), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
  assert.throws(() => template.paragraphs({ foo: "bar" }), (failure: unknown) => failure instanceof BusinessError && failure.code === "INVALID_INPUT")
})

test("A4c export: a saved contract-review result renders a downloadable versioned Word file without any model call", async () => {
  const fixture = await setupReview()
  try {
    const saved = await fixture.results.saveResultRevision(testIdentity, testAuthorizer, {
      projectId, kind: "contract-review", baseVersionId: "", operationId: "human-export", reason: "人工保存",
      value: successResult(validRunnerInput()), sources: [], dependencies: [],
    })
    assert.equal(saved.validation.status, "valid")
    const exports = new ExportService(
      new ExportRepository(fixture.database), fixture.results, fixture.store, productionExportTemplates(),
      async () => "2099-12-31",
    )
    const created = await exports.createExport(testIdentity, testAuthorizer, {
      projectId, resultId: saved.resultId, versionId: saved.versionId, sha256: saved.sha256,
    })
    assert.equal(created.format, "docx")
    assert.equal(created.versionId, saved.versionId)
    const bytes = await exports.download(testIdentity, testAuthorizer, projectId, saved.resultId, created.exportId)
    const document = strFromU8(unzipSync(bytes)["word/document.xml"])
    assert.match(document, /项目合同审查报告/)
    assert.match(document, /AI 辅助生成/)
    assert.match(document, /依据尚未签核/)
    assert.match(document, /contract-review-report-v1/)
    assert.match(document, /依据未签核/)
    const listed = await exports.list(testIdentity, testAuthorizer, projectId, saved.resultId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].exportId, created.exportId)
  } finally { await fixture.close() }
})
