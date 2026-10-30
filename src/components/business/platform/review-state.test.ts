import assert from "node:assert/strict"
import test from "node:test"
import {
  applyReviewDraft,
  buildReviewSubmission,
  budgetDisplay,
  contractReviewResults,
  coverageStatusLabel,
  defaultReviewDraft,
  defaultReviewScene,
  exportBaseName,
  exportAvailability,
  findEquivalentActiveTask,
  findTaskResult,
  formatBudgetAmount,
  formatElapsedDuration,
  formatFenAmount,
  formatReviewTime,
  hasPendingMaterials,
  isReviewDraftDirty,
  isReviewScene,
  materialAvailability,
  mergeResultRows,
  mergeTaskView,
  nextSubmissionOperation,
  newlyFinishedTasks,
  normalizeReviewRegion,
  parseStateLabel,
  parseYuanToFen,
  parseTaskResultSummary,
  projectTaskHint,
  projectTaskStageLabel,
  projectTaskStateLabel,
  readReviewResult,
  reportDocumentTitle,
  reviewableMaterial,
  reviewActionAvailability,
  reviewDecisionLabel,
  reviewSceneLabel,
  reviewSceneOptions,
  reviewSubmissionSignature,
  resultForTask,
  shouldPollReview,
  taskConditionsSummary,
  taskMaterialLabels,
  taskSubmissionSignature,
  toggleReviewMaterial,
  validationStatusLabel,
} from "./review-state"
import type { ProjectReviewMaterial, ProjectResultView, ProjectTaskState, ProjectTaskView } from "../../../lib/business/reviews-client"
import type { ProjectReviewConditions } from "../../../lib/business/contracts"

const hash = "a".repeat(64)

function material(overrides: Partial<ProjectReviewMaterial> = {}): ProjectReviewMaterial {
  return {
    id: "material-1",
    title: "专业分包合同",
    format: "docx",
    versionId: "version-1",
    sha256: hash,
    parseTaskId: "parse-task-1",
    parseState: "success",
    snapshotId: "snapshot-1",
    coverage: { status: "available", textLength: 493, pageCount: 3, findings: [] },
    ...overrides,
  }
}

const conditions: ProjectReviewConditions = {
  scene: "mep-sub-2026",
  role: "专业分包人",
  region: "上海",
  externalProcessingConsent: true,
  unreviewedMaterialsConsent: true,
}

function task(state: ProjectTaskState = "queued", overrides: Partial<ProjectTaskView> = {}): ProjectTaskView {
  return {
    id: "task-1",
    kind: "contract-review",
    projectId: "project-1",
    state,
    stage: state === "running" ? "claimed" : state,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    callsUsed: 0,
    maxCalls: 25,
    elapsedMs: 0,
    manifest: {
      version: 1,
      catalogVersion: 2,
      kind: "contract-review",
      projectId: "project-1",
      refs: { materials: [{ materialVersionId: "version-1", sha256: hash }] },
      conditions,
      submittedBy: "account-1",
      submittedAt: "2026-10-29T00:00:00.000Z",
    },
    error: null,
    resultSummary: null,
    ...overrides,
  }
}

function result(overrides: Partial<ProjectResultView> = {}): ProjectResultView {
  return {
    projectId: "project-1",
    resultId: "result-1",
    versionId: "version-1",
    sha256: "b".repeat(64),
    kind: "contract-review",
    value: null,
    machineOutput: null,
    origin: "machine",
    sources: [],
    dependencies: [],
    provenance: { taskId: "task-1", attempt: 0, manifest: {}, manifestHash: "c".repeat(64) },
    validation: { status: "valid", versionId: "version-1", checkedAt: "2026-10-29T00:00:00.000Z", issues: [] },
    review: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    createdBy: "account-1",
    reason: "",
    ...overrides,
  }
}

function reviewValue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "success",
    documentTitle: "专业分包合同",
    findings: [],
    coverage: [],
    paragraphs: [],
    errors: [],
    warnings: [],
    notLocated: [],
    rejected: [],
    input: { context: { role: "专业分包人" } },
    ...overrides,
  }
}

test("B2a: only the four explicit scenes are exposed; auto is not selectable", () => {
  assert.deepEqual(reviewSceneOptions.map(option => option.value), [
    "mep-sub-2026", "decoration-sub-2026", "curtain-wall-sub-2026", "steel-structure-sub-2026",
  ])
  assert.equal(defaultReviewScene, "mep-sub-2026")
  assert.equal(isReviewScene("auto"), false)
  assert.equal(isReviewScene("mep-sub-2026"), true)
  assert.equal(reviewSceneLabel("mep-sub-2026"), "房建机电安装专业分包")
  assert.equal(reviewSceneLabel("auto"), "自动识别")
  assert.equal(normalizeReviewRegion(" 上海市 "), "上海")
})

test("B2a: task state and stage display the persisted values, and terminal tasks stop polling", () => {
  assert.equal(projectTaskStateLabel("queued"), "排队中")
  assert.equal(projectTaskStateLabel("cancelled"), "已取消")
  assert.equal(projectTaskStateLabel("unexpected"), "unexpected")
  assert.equal(projectTaskStageLabel({ state: "running", stage: "claimed" }), "正在处理")
  assert.equal(projectTaskStageLabel({ state: "success", stage: "success" }), "处理结束")
  assert.equal(projectTaskStageLabel({ state: "running", stage: "unknown-stage" }), "正在处理")
  assert.equal(projectTaskHint({ state: "success" }), "任务已完成；机器审查结论不代表合同无风险，仍需人工复核。")
  assert.equal(formatElapsedDuration(61_000), "1 分 1 秒")
  assert.equal(formatElapsedDuration(9_000), "9 秒")
  assert.equal(formatElapsedDuration(Number.NaN), "")
  assert.match(formatReviewTime("2026-10-29T06:00:00.000Z"), /2026/)
  assert.equal(formatReviewTime("not-a-time"), "")
})

test("B2a: a poll refresh keeps newest tasks first and only reports real active→terminal transitions", () => {
  const queued = task("queued")
  const running = task("running", { id: "task-2", createdAt: "2026-10-29T01:00:00.000Z" })
  const rows = mergeTaskView(mergeTaskView([], queued), running)
  assert.deepEqual(rows.map(item => item.id), ["task-2", "task-1"])
  const updated = mergeTaskView(rows, { ...queued, state: "success", stage: "success" })
  assert.equal(updated.length, 2)
  assert.equal(updated.find(item => item.id === "task-1")?.state, "success")
  const finished = newlyFinishedTasks([queued, running], [updated[0], { ...running, state: "failed" }, updated[1]])
  // task-1 finished successfully; the failed task never owned a machine result.
  assert.deepEqual(finished.map(item => item.id), ["task-1"])
  assert.deepEqual(newlyFinishedTasks([], [updated[1]]), [])
})

test("B2a: only materials with a usable parse snapshot can be selected", () => {
  assert.equal(reviewableMaterial(material()), true)
  assert.equal(reviewableMaterial(material({ coverage: { status: "partial", textLength: 120, pageCount: 1, findings: [] } })), true)
  assert.equal(materialAvailability(material({ coverage: { status: "failed", textLength: 0, pageCount: 1, findings: [] } })).reason, "解析失败")
  assert.equal(materialAvailability(material({ snapshotId: null, parseState: "running" })).reason, "正在解析")
  assert.equal(materialAvailability(material({ snapshotId: null, parseState: null, parseTaskId: null })).reason, "无解析快照")
  assert.equal(materialAvailability(material()).reviewable, true)
  assert.equal(parseStateLabel("success"), "已完成")
  assert.equal(parseStateLabel(null), "无解析任务")
  assert.equal(coverageStatusLabel("partial"), "部分覆盖")
  assert.equal(hasPendingMaterials([material({ snapshotId: null, parseState: "queued" })]), true)
  assert.equal(hasPendingMaterials([material({ snapshotId: null, parseState: "failed" })]), false)
  assert.equal(hasPendingMaterials([material()]), false)
  assert.equal(shouldPollReview([task("queued")], []), true, "a running persisted task keeps polling")
  assert.equal(shouldPollReview([task("running")], []), true)
  assert.equal(shouldPollReview([task("success")], []), false, "a terminal task stops polling")
  assert.equal(shouldPollReview([task("failed")], []), false)
  assert.equal(shouldPollReview([], [material({ snapshotId: null, parseState: "running" })]), true, "a pending parse job keeps refreshing material state")
  assert.equal(shouldPollReview([], [material()]), false)
})

test("B2a: material selection is version-bound, deduplicated and capped at ten", () => {
  let draft = defaultReviewDraft()
  assert.equal(isReviewDraftDirty(draft), false)
  draft = toggleReviewMaterial(draft, material())
  assert.equal(draft.materials.length, 1)
  assert.equal(isReviewDraftDirty(draft), true)
  draft = toggleReviewMaterial(draft, material())
  assert.equal(draft.materials.length, 0)
  draft = toggleReviewMaterial(draft, material({ snapshotId: null }))
  assert.equal(draft.materials.length, 0)
  draft = toggleReviewMaterial(draft, material({ versionId: "version-2", sha256: "d".repeat(64) }))
  assert.equal(draft.materials[0].versionId, "version-2")
  let many = defaultReviewDraft()
  for (let index = 1; index <= 10; index++) {
    many = toggleReviewMaterial(many, material({ id: `material-${index}`, versionId: `version-${index}` }))
  }
  assert.equal(many.materials.length, 10)
  const capped = toggleReviewMaterial(many, material({ id: "material-11", versionId: "version-11" }))
  assert.equal(capped.materials.length, 10, "an eleventh selection must not silently evict another material")
  // A stale stored selection is dropped rather than submitted with an old digest.
  const restored = applyReviewDraft({ ...many, scene: "auto" as never }, [material({ versionId: "version-2" })])
  assert.deepEqual(restored.materials, [])
  assert.equal(restored.scene, defaultReviewScene)
  const kept = applyReviewDraft(draft, [material({ versionId: "version-2", sha256: "d".repeat(64) })])
  assert.deepEqual(kept.materials, [{ id: "material-1", versionId: "version-2", sha256: "d".repeat(64) }])
})

test("B2a: submission requires both consents, a parsed material, a scene and a project region", () => {
  const selected = { ...toggleReviewMaterial(defaultReviewDraft(), material()), region: "上海市" }
  const ready = buildReviewSubmission(selected, [material()], { externalProcessing: true, unreviewedMaterials: true })
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.materials, [{ materialVersionId: "version-1", sha256: hash }])
  assert.deepEqual(ready.conditions, {
    scene: "mep-sub-2026", role: "专业分包人", region: "上海",
    externalProcessingConsent: true, unreviewedMaterialsConsent: true,
  })
  const missingConsents = buildReviewSubmission(selected, [material()], { externalProcessing: false, unreviewedMaterials: false })
  assert.equal(missingConsents.ready, false)
  assert.deepEqual(missingConsents.issues, ["请确认外部处理授权。", "请确认审查依据尚未签核。"])
  const noMaterial = buildReviewSubmission({ ...defaultReviewDraft(), region: "上海市" }, [], { externalProcessing: true, unreviewedMaterials: true })
  assert.equal(noMaterial.ready, false)
  assert.deepEqual(noMaterial.issues, ["请选择至少 1 份已解析材料。"])
  const stale = buildReviewSubmission(selected, [material({ versionId: "version-2" })], { externalProcessing: true, unreviewedMaterials: true })
  assert.equal(stale.ready, false)
  const badScene = buildReviewSubmission({ ...selected, scene: "auto" as never }, [material()], { externalProcessing: true, unreviewedMaterials: true })
  assert.equal(badScene.ready, false)
  const noRegion = buildReviewSubmission({ ...selected, region: "  " }, [material()], { externalProcessing: true, unreviewedMaterials: true })
  assert.equal(noRegion.ready, false)
})

test("B2a: idempotency follows the exact input and identical running tasks are detected", () => {
  const submission = buildReviewSubmission({ ...toggleReviewMaterial(defaultReviewDraft(), material()), region: "上海市" }, [material()], { externalProcessing: true, unreviewedMaterials: true })
  const signature = reviewSubmissionSignature(submission)
  assert.equal(signature, reviewSubmissionSignature(submission))
  assert.equal(taskSubmissionSignature(task()), signature)
  assert.equal(findEquivalentActiveTask([task("queued")], signature)?.id, "task-1")
  assert.equal(findEquivalentActiveTask([task("success")], signature), null)
  let keyCount = 0
  const createKey = () => `key-${++keyCount}`
  const first = nextSubmissionOperation(null, signature, createKey)
  assert.deepEqual(nextSubmissionOperation(first, signature, createKey), first)
  const changed = nextSubmissionOperation(first, `${signature}x`, createKey)
  assert.equal(changed.key, "key-2")
  assert.equal(keyCount, 2)
})

test("B2a: task input lists map stored versions to current material names", () => {
  const labels = taskMaterialLabels(task(), [material()])
  assert.deepEqual(labels, [{ versionId: "version-1", title: "专业分包合同" }])
  assert.deepEqual(taskMaterialLabels(task(), []), [{ versionId: "version-1", title: "不可用的材料版本" }])
  assert.deepEqual(taskConditionsSummary(task()), { scene: "房建机电安装专业分包", region: "上海", role: "专业分包人" })
})

test("B2a: results are selected by task provenance and decoded defensively", () => {
  const older = result({ resultId: "result-0", createdAt: "2026-10-29T00:00:00.000Z" })
  const newer = result({ resultId: "result-1", createdAt: "2026-10-29T02:00:00.000Z" })
  const otherKind = result({ resultId: "result-2", kind: "payment-reconciliation", createdAt: "2026-10-29T03:00:00.000Z" })
  assert.deepEqual(contractReviewResults([older, otherKind, newer]).map(item => item.resultId), ["result-1", "result-0"])
  assert.equal(findTaskResult([older, otherKind, newer], "task-1")?.resultId, "result-1")
  assert.equal(findTaskResult([older], "missing"), null)
  const decoded = readReviewResult(reviewValue())
  assert.equal(decoded?.documentTitle, "专业分包合同")
  assert.equal(readReviewResult(reviewValue({ schemaVersion: 2 })), null)
  assert.equal(readReviewResult(reviewValue({ findings: undefined })), null)
  assert.equal(readReviewResult(reviewValue({ input: {} })), null)
  assert.equal(readReviewResult("value"), null)
  assert.equal(reportDocumentTitle(reviewValue()), "专业分包合同")
  assert.equal(reportDocumentTitle(null), "合同审查")
})

test("B2a: validation and review gates never let an invalid version be approved", () => {
  assert.equal(validationStatusLabel("valid"), "校验通过")
  assert.equal(validationStatusLabel("invalid"), "校验未通过")
  assert.equal(reviewDecisionLabel(null), "待复核")
  assert.equal(reviewDecisionLabel({ versionId: "v", decision: "rejected", comment: "", reviewedBy: "a", reviewedAt: "t" }), "已驳回")
  const valid = { status: "valid" as const, versionId: "v", checkedAt: "t", issues: [] }
  const invalid = { status: "invalid" as const, versionId: "v", checkedAt: "t", issues: [] }
  assert.equal(reviewActionAvailability(true, valid, null).canApprove, true)
  assert.equal(reviewActionAvailability(true, invalid, null).canApprove, false)
  assert.equal(reviewActionAvailability(true, invalid, null).approveHint, "成果校验未通过，不能批准。")
  assert.equal(reviewActionAvailability(false, valid, null).canApprove, false)
  assert.equal(reviewActionAvailability(false, valid, null).approveHint, "只读成员不能复核。")
  assert.equal(reviewActionAvailability(true, valid, { versionId: "v", decision: "approved", comment: "", reviewedBy: "a", reviewedAt: "t" }).canApprove, false)
  assert.equal(exportAvailability(true, valid).canExport, true)
  assert.equal(exportAvailability(true, { status: "partial" }).canExport, true, "a partial report may still be exported as a draft")
  assert.equal(exportAvailability(true, invalid).canExport, false)
  assert.equal(exportAvailability(true, invalid).exportHint, "成果校验未通过，不能导出。")
  assert.equal(exportAvailability(false, valid).canExport, false)
})

test("B2a: the recorded task result reference links a task to its saved machine result", () => {
  const summary = { resultId: "result-1", versionId: "version-1", sha256: "b".repeat(64), status: "success", validation: "valid" }
  const recordedTask = task("success", { resultSummary: JSON.stringify(summary) })
  assert.deepEqual(parseTaskResultSummary(recordedTask), summary)
  assert.equal(parseTaskResultSummary(task()), null)
  assert.equal(parseTaskResultSummary(task("success", { resultSummary: "not-json" })), null)
  assert.equal(parseTaskResultSummary(task("success", { resultSummary: JSON.stringify({ resultId: "only-id" }) })), null)
  const recorded = result({ resultId: "result-1" })
  const provenance = result({ resultId: "result-9", provenance: { taskId: "task-1", attempt: 0, manifest: {}, manifestHash: "c".repeat(64) } })
  assert.equal(resultForTask([provenance, recorded], recordedTask)?.resultId, "result-1")
  assert.equal(resultForTask([provenance], recordedTask)?.resultId, "result-9", "provenance remains the fallback link")
  assert.equal(resultForTask([provenance], task("success", { id: "task-2" })), null)
})

test("B2a: export file names are sanitised and version-free", () => {
  assert.equal(exportBaseName(" 专业/分包:合同 "), "专业_分包_合同-审查报告")
  assert.equal(exportBaseName("   "), "合同审查-审查报告")
})

test("B2a: budget amounts use integer fen arithmetic and keep negative remainders visible", () => {
  assert.equal(formatFenAmount(300000), "3,000.00")
  assert.equal(formatFenAmount(-50), "-0.50")
  assert.equal(formatFenAmount(0), "0.00")
  assert.equal(formatFenAmount(2_147_483_647), "21,474,836.47")
  assert.equal(formatFenAmount(Number.NaN), "—")
  assert.equal(formatBudgetAmount(300000), "3,000.00 元")
  assert.deepEqual(parseYuanToFen("3,000"), { ok: true, fen: 300000 })
  assert.deepEqual(parseYuanToFen("3000.50"), { ok: true, fen: 300050 })
  assert.deepEqual(parseYuanToFen("¥ 12.3"), { ok: true, fen: 1230 })
  assert.equal(parseYuanToFen("").ok, false)
  assert.equal(parseYuanToFen("12.345").ok, false)
  assert.equal(parseYuanToFen("abc").ok, false)
  assert.equal(parseYuanToFen("0").ok, false)
  assert.equal(parseYuanToFen("0.00").ok, false)
  assert.equal(parseYuanToFen("21474836.48").ok, false)
  const display = budgetDisplay({
    projectId: "project-1", costLimitFen: 300000, costReservedFen: 1000, costChargedFen: 2000,
    remainingFen: 297000, registeredBy: "account-1", registeredAt: "t", updatedAt: "t", revision: 1,
  })
  assert.deepEqual(display, { limit: "3,000.00 元", remaining: "2,970.00 元", committed: "30.00 元", reserved: "10.00 元", charged: "20.00 元" })
})

test("B2a: a selected material that became un-reviewable can still be deselected", () => {
  const selected = { id: "material-1", versionId: "version-1", sha256: "b".repeat(64) }
  const draft = { version: 1 as const, materials: [selected], scene: defaultReviewScene, region: "上海" }
  const unavailable = { id: "material-1", title: "合同", fileName: "a.docx", format: "docx" as const, size: 1, sha256: "b".repeat(64), versionId: "version-1", createdAt: "t", parseTaskId: null, parseState: "failed" as const, snapshotId: null, coverage: null }
  assert.equal(toggleReviewMaterial(draft, unavailable).materials.length, 0)
})

test("B2a: result merges keep newly created results and let refreshed rows win", () => {
  const previous = [
    { resultId: "result-a", versionId: "v1", createdAt: "2026-10-29T01:00:00.000Z" },
    { resultId: "result-b", versionId: "v1", createdAt: "2026-10-29T02:00:00.000Z" },
  ] as ProjectResultView[]
  const refreshed = [
    { resultId: "result-a", versionId: "v2", createdAt: "2026-10-29T01:00:00.000Z" },
    { resultId: "result-c", versionId: "v1", createdAt: "2026-10-29T03:00:00.000Z" },
  ] as ProjectResultView[]
  const merged = mergeResultRows(previous, refreshed)
  assert.deepEqual(merged.map(row => row.resultId), ["result-c", "result-b", "result-a"])
  assert.equal(merged.find(row => row.resultId === "result-a")?.versionId, "v2")
})
