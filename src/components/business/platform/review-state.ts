import type {
  ProjectReviewConditions,
  ProjectReviewMaterialRef,
  ProjectReviewScene,
  ResultReview,
  ResultValidation,
} from "../../../lib/business/contracts"
import type { ProjectBudgetView, ProjectReviewMaterial, ProjectResultView, ProjectTaskView } from "../../../lib/business/reviews-client"
import type { ReviewResult } from "../../../lib/contract-reviews/types"
import { normalizeRegion } from "../../../lib/contract-reviews/regions"
import { sceneIds, scenes } from "../../../../tools/contract-review/src/scenes"

/**
 * Pure presentation and lifecycle logic for the project contract-review
 * workspace (B2a). Everything here is deterministic and testable without React
 * or the network; the component only wires it to state and HTTP.
 */

export const reviewPollIntervalMs = 5000

/** GaussDB INTEGER ceiling used by the server budget ledger (2^31-1 fen). */
export const maxProjectBudgetFen = 2_147_483_647

/** Only the four explicitly registered scenes are exposed; auto is not selectable this round. */
export const reviewSceneOptions: readonly { value: ProjectReviewScene; label: string }[] = [
  ...sceneIds.map(id => ({ value: id as ProjectReviewScene, label: scenes[id].label })),
]
export const defaultReviewScene: ProjectReviewScene = "mep-sub-2026"
const reviewSceneValues = new Set<string>(reviewSceneOptions.map(option => option.value))

export function isReviewScene(value: unknown): value is ProjectReviewScene {
  return typeof value === "string" && reviewSceneValues.has(value)
}

export function reviewSceneLabel(value: ProjectReviewScene | string | null | undefined): string {
  if (!value) return ""
  if (value === "auto") return "自动识别"
  return reviewSceneOptions.find(option => option.value === value)?.label ?? value
}

export function normalizeReviewRegion(value: string): string {
  return normalizeRegion(value)
}

export type ProjectReviewConsents = { externalProcessing: boolean; unreviewedMaterials: boolean }

const taskStateLabels: Record<string, string> = {
  queued: "排队中", running: "处理中", success: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消",
}
const taskStageLabels: Record<string, string> = {
  submitted: "等待处理", claimed: "正在处理", queued: "等待处理", running: "正在处理",
  success: "处理结束", partial: "部分完成", failed: "处理停止", cancelled: "已取消",
}

export function isActiveTask(task: Pick<ProjectTaskView, "state">): boolean {
  return task.state === "queued" || task.state === "running"
}

export function projectTaskStateLabel(state: string): string {
  return taskStateLabels[state] ?? state
}

export function projectTaskStageLabel(task: Pick<ProjectTaskView, "stage" | "state">): string {
  const label = taskStageLabels[task.stage]
  if (label) return label
  return isActiveTask(task) ? "正在处理" : projectTaskStateLabel(task.state)
}

export function projectTaskHint(task: Pick<ProjectTaskView, "state">): string {
  switch (task.state) {
    case "queued": return "任务已提交，正在排队。"
    case "running": return "任务正在处理；离开页面不会取消后台任务。"
    case "success": return "任务已完成；机器审查结论不代表合同无风险，仍需人工复核。"
    case "partial": return "任务部分完成，未完成项仍需核对；不代表合同无风险。"
    case "failed": return "任务处理失败，已有结果可能不完整；不代表合同无风险。"
    case "cancelled": return "任务已取消，未形成完整审查结论。"
    default: return "任务状态以服务端记录为准。"
  }
}

export function formatElapsedDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ""
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function formatReviewTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ""
  return new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
}

/** Merge one refreshed task view into a list, keeping newest created first. */
export function mergeTaskView(tasks: ProjectTaskView[], updated: ProjectTaskView): ProjectTaskView[] {
  const next = tasks.some(task => task.id === updated.id)
    ? tasks.map(task => task.id === updated.id ? updated : task)
    : [updated, ...tasks]
  return [...next].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

/** Merge a refreshed result list without dropping results created after the request began. */
export function mergeResultRows(previous: ProjectResultView[], rows: ProjectResultView[]): ProjectResultView[] {
  const merged = new Map(previous.map(row => [row.resultId, row]))
  for (const row of rows) merged.set(row.resultId, row)
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** Tasks that finished in this refresh and may now own a saved machine result. */
export function newlyFinishedTasks(previous: readonly ProjectTaskView[], next: readonly ProjectTaskView[]): ProjectTaskView[] {
  const before = new Map(previous.map(task => [task.id, task.state]))
  return next.filter(task => (task.state === "success" || task.state === "partial") &&
    (before.get(task.id) === "queued" || before.get(task.id) === "running"))
}

export function hasPendingMaterials(materials: readonly Pick<ProjectReviewMaterial, "parseTaskId" | "parseState" | "snapshotId">[]): boolean {
  return materials.some(material => Boolean(material.parseTaskId) && !material.snapshotId &&
    (material.parseState === null || material.parseState === "queued" || material.parseState === "running"))
}

/** Polling continues only while a persisted task runs or a submitted parse job is pending. */
export function shouldPollReview(tasks: readonly Pick<ProjectTaskView, "state">[], materials: readonly Pick<ProjectReviewMaterial, "parseTaskId" | "parseState" | "snapshotId">[]): boolean {
  return tasks.some(isActiveTask) || hasPendingMaterials(materials)
}

/* --- Materials ----------------------------------------------------------- */

const parseStateLabels: Record<string, string> = {
  queued: "排队中", running: "处理中", success: "已完成", succeeded: "已完成", completed: "已完成",
  partial: "部分完成", failed: "失败", cancelled: "已取消",
}
const coverageLabels: Record<string, string> = { available: "已覆盖", partial: "部分覆盖", failed: "解析失败" }

export function parseStateLabel(state: string | null): string {
  if (!state) return "无解析任务"
  return parseStateLabels[state] ?? state
}

export function coverageStatusLabel(status: "available" | "partial" | "failed"): string {
  return coverageLabels[status] ?? status
}

/** A reviewable material has an immutable parse snapshot whose coverage did not fail. */
export function reviewableMaterial(material: ProjectReviewMaterial): boolean {
  return Boolean(material.snapshotId) && material.coverage !== null && material.coverage.status !== "failed"
}

export function materialAvailability(material: ProjectReviewMaterial): { reviewable: boolean; reason: string } {
  if (reviewableMaterial(material)) return { reviewable: true, reason: "" }
  if (material.coverage?.status === "failed") return { reviewable: false, reason: "解析失败" }
  if (material.parseState === "queued" || material.parseState === "running") return { reviewable: false, reason: "正在解析" }
  if (!material.snapshotId) return { reviewable: false, reason: "无解析快照" }
  return { reviewable: false, reason: "不可用于审查" }
}

/* --- Review draft -------------------------------------------------------- */

export type ReviewMaterialSelection = { id: string; versionId: string; sha256: string }
export type ReviewDraft = { version: 1; materials: ReviewMaterialSelection[]; scene: ProjectReviewScene; region: string }

export function defaultReviewDraft(): ReviewDraft {
  return { version: 1, materials: [], scene: defaultReviewScene, region: "" }
}

export function reviewMaterialSelection(material: ProjectReviewMaterial): ReviewMaterialSelection {
  return { id: material.id, versionId: material.versionId, sha256: material.sha256 }
}

export function isMaterialSelected(draft: ReviewDraft, materialId: string): boolean {
  return draft.materials.some(item => item.id === materialId)
}

/** Selection is version-bound: a re-parsed or re-uploaded material must be chosen again. */
export function toggleReviewMaterial(draft: ReviewDraft, material: ProjectReviewMaterial): ReviewDraft {
  const existing = draft.materials.find(item => item.id === material.id)
  // Removal must always stay available, even if the material later became un-reviewable,
  // otherwise a stale selection blocks submission with no way to clear it.
  if (existing) {
    if (reviewableMaterial(material) && (existing.versionId !== material.versionId || existing.sha256 !== material.sha256)) {
      return { ...draft, materials: draft.materials.map(item => item.id === material.id ? reviewMaterialSelection(material) : item) }
    }
    return { ...draft, materials: draft.materials.filter(item => item.id !== material.id) }
  }
  if (!reviewableMaterial(material)) return draft
  // The frozen refs allow at most ten materials per task; never silently drop a selection.
  if (draft.materials.length >= 10) return draft
  return { ...draft, materials: [...draft.materials, reviewMaterialSelection(material)] }
}

/** Restore a stored selection only where the identical material version is still reviewable. */
export function applyReviewDraft(draft: ReviewDraft, materials: readonly ProjectReviewMaterial[]): ReviewDraft {
  const selected = draft.materials.flatMap(stored => {
    const material = materials.find(item => item.id === stored.id)
    if (!material || !reviewableMaterial(material)) return []
    if (material.versionId !== stored.versionId || material.sha256 !== stored.sha256) return []
    return [reviewMaterialSelection(material)]
  })
  return {
    version: 1,
    materials: selected,
    scene: isReviewScene(draft.scene) ? draft.scene : defaultReviewScene,
    region: draft.region.slice(0, 100),
  }
}

export function isReviewDraftDirty(draft: ReviewDraft): boolean {
  return draft.materials.length > 0 || draft.scene !== defaultReviewScene || draft.region.trim() !== ""
}

export function reviewDraftFromForm(materials: readonly ProjectReviewMaterial[], scene: ProjectReviewScene, region: string): ReviewDraft {
  return {
    version: 1,
    materials: materials.filter(reviewableMaterial).map(reviewMaterialSelection),
    scene: isReviewScene(scene) ? scene : defaultReviewScene,
    region,
  }
}

export type ReviewSubmission = {
  ready: boolean
  issues: string[]
  materials: ProjectReviewMaterialRef[]
  conditions: ProjectReviewConditions
}

/**
 * Build the frozen task conditions. Both consent boxes are mandatory because
 * the executor requires externalProcessingConsent and unreviewedMaterialsConsent
 * to be true before any paid call.
 */
export function buildReviewSubmission(draft: ReviewDraft, materials: readonly ProjectReviewMaterial[], consents: ProjectReviewConsents): ReviewSubmission {
  const issues: string[] = []
  const selected = draft.materials.map(stored => {
    const material = materials.find(item => item.id === stored.id)
    if (!material || !reviewableMaterial(material)) return null
    if (material.versionId !== stored.versionId || material.sha256 !== stored.sha256) return null
    return material
  })
  if (selected.some(material => material === null)) issues.push("所选材料版本已变化或已不可用，请重新选择。")
  const usable = selected.filter((material): material is ProjectReviewMaterial => material !== null)
  if (usable.length < 1) issues.push("请选择至少 1 份已解析材料。")
  if (usable.length > 10) issues.push("一次最多选择 10 份材料。")
  if (!isReviewScene(draft.scene)) issues.push("请选择审查场景。")
  const region = normalizeReviewRegion(draft.region)
  if (!region) issues.push("请填写项目地域。")
  else if (region.length > 100) issues.push("项目地域不得超过 100 字。")
  if (!consents.externalProcessing) issues.push("请确认外部处理授权。")
  if (!consents.unreviewedMaterials) issues.push("请确认审查依据尚未签核。")
  return {
    ready: issues.length === 0,
    issues,
    materials: usable.map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 })),
    conditions: {
      scene: draft.scene,
      role: "专业分包人",
      region,
      externalProcessingConsent: true,
      unreviewedMaterialsConsent: true,
    },
  }
}

function signatureOf(materials: readonly ProjectReviewMaterialRef[], conditions: Partial<ProjectReviewConditions>): string {
  return JSON.stringify({
    materials: materials.map(item => ({ materialVersionId: item.materialVersionId, sha256: item.sha256 })),
    conditions: {
      asOf: conditions.asOf ?? null,
      scene: conditions.scene ?? null,
      role: conditions.role ?? null,
      region: conditions.region ?? null,
      externalProcessingConsent: conditions.externalProcessingConsent ?? null,
      unreviewedMaterialsConsent: conditions.unreviewedMaterialsConsent ?? null,
    },
  })
}

export function reviewSubmissionSignature(submission: Pick<ReviewSubmission, "materials" | "conditions">): string {
  return signatureOf(submission.materials, submission.conditions)
}

export function taskSubmissionSignature(task: Pick<ProjectTaskView, "manifest">): string | null {
  const materials = task.manifest.refs?.materials
  const conditions = task.manifest.conditions
  if (!Array.isArray(materials) || !conditions) return null
  return signatureOf(materials, conditions)
}

/** An identical input already running must not create a second paid task. */
export function findEquivalentActiveTask(tasks: readonly ProjectTaskView[], signature: string): ProjectTaskView | null {
  return tasks.find(task => task.kind === "contract-review" && isActiveTask(task) && taskSubmissionSignature(task) === signature) ?? null
}

export type SubmissionOperation = { signature: string; key: string }

/** Idempotency is kept per submission input; a changed input gets a new key. */
export function nextSubmissionOperation(previous: SubmissionOperation | null, signature: string, createKey: () => string): SubmissionOperation {
  if (previous && previous.signature === signature) return previous
  return { signature, key: createKey() }
}

export function taskMaterialLabels(task: Pick<ProjectTaskView, "manifest">, materials: readonly ProjectReviewMaterial[]): { versionId: string; title: string }[] {
  const refs = task.manifest.refs?.materials
  if (!Array.isArray(refs)) return []
  return refs.map(ref => ({
    versionId: ref.materialVersionId,
    title: materials.find(material => material.versionId === ref.materialVersionId)?.title ?? "不可用的材料版本",
  }))
}

export function taskConditionsSummary(task: Pick<ProjectTaskView, "manifest">): { scene: string; region: string; role: string } {
  const conditions = task.manifest.conditions ?? {}
  return {
    scene: reviewSceneLabel(conditions.scene),
    region: typeof conditions.region === "string" && conditions.region.trim() ? conditions.region : "未提供",
    role: typeof conditions.role === "string" && conditions.role.trim() ? conditions.role : "未提供",
  }
}

/* --- Results ------------------------------------------------------------- */

export function isContractReviewResult(result: Pick<ProjectResultView, "kind">): boolean {
  return result.kind === "contract-review"
}

export function contractReviewResults(results: readonly ProjectResultView[]): ProjectResultView[] {
  return results
    .filter(isContractReviewResult)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.resultId.localeCompare(left.resultId))
}

export function findTaskResult(results: readonly ProjectResultView[], taskId: string): ProjectResultView | null {
  return contractReviewResults(results).find(result => result.provenance?.taskId === taskId) ?? null
}

/** The executor records the saved machine result reference in the task result summary. */
export type TaskResultSummary = { resultId: string; versionId: string; sha256: string; status: string; validation: string }

export function parseTaskResultSummary(task: Pick<ProjectTaskView, "resultSummary">): TaskResultSummary | null {
  if (!task.resultSummary) return null
  let value: unknown
  try { value = JSON.parse(task.resultSummary) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.resultId !== "string" || !candidate.resultId) return null
  if (typeof candidate.versionId !== "string" || !candidate.versionId) return null
  if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) return null
  return {
    resultId: candidate.resultId,
    versionId: candidate.versionId,
    sha256: candidate.sha256,
    status: typeof candidate.status === "string" ? candidate.status : "",
    validation: typeof candidate.validation === "string" ? candidate.validation : "",
  }
}

/** Prefer the recorded task→result reference; fall back to the immutable provenance link. */
export function resultForTask(results: readonly ProjectResultView[], task: Pick<ProjectTaskView, "id" | "resultSummary">): ProjectResultView | null {
  const summary = parseTaskResultSummary(task)
  if (summary) {
    const recorded = results.find(result => result.resultId === summary.resultId)
    if (recorded) return recorded
  }
  return findTaskResult(results, task.id)
}

/** Decode the machine result value only when it still has the report structure. */
export function readReviewResult(value: unknown): ReviewResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<ReviewResult> & Record<string, unknown>
  if (candidate.schemaVersion !== 1) return null
  if (!["success", "partial", "failed"].includes(String(candidate.status))) return null
  if (typeof candidate.documentTitle !== "string") return null
  if (!Array.isArray(candidate.findings) || !Array.isArray(candidate.coverage) || !Array.isArray(candidate.paragraphs)) return null
  if (!Array.isArray(candidate.errors) || !Array.isArray(candidate.warnings) || !Array.isArray(candidate.notLocated) || !Array.isArray(candidate.rejected)) return null
  const input = candidate.input as Record<string, unknown>
  if (!input || typeof input !== "object" || !input.context || typeof input.context !== "object") return null
  return candidate as ReviewResult
}

export function reportDocumentTitle(value: unknown): string {
  return readReviewResult(value)?.documentTitle.trim() || "合同审查"
}

export function validationStatusLabel(status: ResultValidation["status"]): string {
  return status === "valid" ? "校验通过" : status === "invalid" ? "校验未通过" : "部分校验"
}

export function reviewDecisionLabel(review: ResultReview | null): string {
  if (!review) return "待复核"
  switch (review.decision) {
    case "approved": return "已批准"
    case "rejected": return "已驳回"
    case "changes_requested": return "退回修改"
    default: return "待复核"
  }
}

/** Approve is blocked unless the current version validates; reject stays available to editors. */
export function reviewActionAvailability(canEdit: boolean, validation: Pick<ResultValidation, "status">, review: ResultReview | null): { canApprove: boolean; canReject: boolean; approveHint: string } {
  if (!canEdit) return { canApprove: false, canReject: false, approveHint: "只读成员不能复核。" }
  if (validation.status !== "valid") return { canApprove: false, canReject: true, approveHint: "成果校验未通过，不能批准。" }
  if (review?.decision === "approved") return { canApprove: false, canReject: true, approveHint: "该版本已批准。" }
  return { canApprove: true, canReject: true, approveHint: "" }
}

/** Invalid results can be reviewed/rejected but never approved or exported (spec 8.2.2). */
export function exportAvailability(canEdit: boolean, validation: Pick<ResultValidation, "status">): { canExport: boolean; exportHint: string } {
  if (!canEdit) return { canExport: false, exportHint: "只读成员不能创建导出。" }
  if (validation.status === "invalid") return { canExport: false, exportHint: "成果校验未通过，不能导出。" }
  return { canExport: true, exportHint: "" }
}

export function exportBaseName(title: string): string {
  const safe = title.trim().slice(0, 120).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "")
  return `${safe || "合同审查"}-审查报告`
}

/* --- Project budget ------------------------------------------------------ */

/** Format integer fen with two decimals and thousands separators; negative stays visible. */
export function formatFenAmount(fen: number): string {
  if (!Number.isFinite(fen) || !Number.isSafeInteger(fen)) return "—"
  const negative = fen < 0
  const absolute = Math.abs(fen)
  const yuan = Math.floor(absolute / 100)
  const cents = absolute % 100
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}${grouped}.${String(cents).padStart(2, "0")}`
}

export function formatBudgetAmount(fen: number): string {
  return `${formatFenAmount(fen)} 元`
}

/** Parse a precise yuan amount into integer fen without floating-point arithmetic. */
export function parseYuanToFen(value: string): { ok: true; fen: number } | { ok: false; message: string } {
  const compact = value.trim().replace(/[¥￥,，\s]/g, "")
  if (!compact) return { ok: false, message: "请填写预算上限。" }
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(compact)
  if (!match) return { ok: false, message: "预算上限须为最多两位小数的金额。" }
  const fen = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  if (!Number.isSafeInteger(fen) || fen > maxProjectBudgetFen) return { ok: false, message: `预算上限不得超过 ${formatBudgetAmount(maxProjectBudgetFen)}。` }
  if (fen <= 0) return { ok: false, message: "预算上限须大于 0。" }
  return { ok: true, fen }
}

export function budgetDisplay(budget: ProjectBudgetView): { limit: string; remaining: string; committed: string; reserved: string; charged: string } {
  return {
    limit: formatBudgetAmount(budget.costLimitFen),
    remaining: formatBudgetAmount(budget.remainingFen),
    committed: formatBudgetAmount(budget.costReservedFen + budget.costChargedFen),
    reserved: formatBudgetAmount(budget.costReservedFen),
    charged: formatBudgetAmount(budget.costChargedFen),
  }
}
