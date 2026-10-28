import type { ReviewResult, ReviewContext } from "../../../tools/contract-review/src/types"
import type { DocumentTaskKind } from "../document-agent/types"
import type { LetterPlan } from "../document-agent/types"
import type { SceneId, SceneCandidate } from "../../../tools/contract-review/src/scenes"
export type { ReviewResult, ReviewContext }
export type ReviewTaskState = "queued" | "running" | "success" | "partial" | "failed"
export type ReviewTask = {
  kind?: "contract-review" | DocumentTaskKind
  asOf?: string
  maxKnownTokens?: number
  sourceTaskId?: string
  sceneReselection?: { scene: SceneId; sourceTaskId: string; reason: string; selectedAt: string }
  id: string; documentId: string; revisionId: string; title: string; state: ReviewTaskState; stage: string
  createdAt: string; updatedAt: string; expiresAt: string; attempt: number; callsUsed: number; maxCalls: number
  progress: { readParagraphCount: number; paragraphCount: number; submittedRuleCount: number; agentRole?: "router" | "primary" | "reviser" | "auditor"; auditedRuleCount?: number }
  error: { code: string; message: string } | null
  result?: ReviewResult | null
}
export type ReviewAvailability = {
  exchangeRetention?: "full" | "summary"
  models?: { router: string; primary: string; auditor: string }
  sceneCandidates?: SceneCandidate[]
  documentTasks?: { ready: boolean; configurationId: string; maxCalls: number; maxKnownTokens: number; error?: string }
  ready: boolean; mode: "published" | "debug"; model: string; providerHost: string; retentionDays: number; maxKnownTokens: number; configurationId: string; error?: string
}
/** 新网页任务由 Agent 识别场景；用户只确认其代表的立场与地域。 */
export type SubmitContext = { scene: "auto" | SceneId; role: "专业分包人"; region: string }
export type SubmitReview = {
  task?: "contract-review" | DocumentTaskKind
  asOf?: string
  letterPlan?: LetterPlan
  paymentTaskId?: string
  evidenceTaskId?: string
  documentId: string; revisionId: string; context: SubmitContext
  externalProcessingConsent: true; unreviewedMaterialsConsent: boolean
  configurationId: string
  generateRevision?: boolean
  sceneSource?: "user"
  sceneSourceTaskId?: string
  sceneReason?: string
}
export const taskStateLabel: Record<ReviewTaskState, string> = {
  queued: "排队中", running: "处理中", success: "已完成", partial: "部分完成", failed: "失败",
}
export const taskStageLabel: Record<string, string> = {
  queued: "等待处理", parsing: "解析文档", prepared: "准备审查", organizing: "整理资料", identifying: "识别场景", reviewing: "主审合同",
  revising: "修订合同", auditing: "AI 核对", validating: "校验结果", completed: "处理结束", recovering: "恢复排队", cancelled: "已取消", failed: "处理失败",
}

/** 场景识别未匹配是受控停止，不是执行失败；界面不能显示「失败」。 */
export function taskDisplayState(task: Pick<ReviewTask, "state" | "error">): string {
  if (task.error?.code === "REVIEW_SCENE_UNSUPPORTED") return "场景不支持"
  if (task.error?.code === "REVIEW_SCENE_UNCERTAIN") return "场景待确认"
  return taskStateLabel[task.state]
}

export function taskDisplayStage(task: Pick<ReviewTask, "stage" | "error">): string {
  if (task.error?.code === "REVIEW_SCENE_UNSUPPORTED" || task.error?.code === "REVIEW_SCENE_UNCERTAIN") return "等待补充材料"
  return taskStageLabel[task.stage] ?? "处理中"
}

/** success 只表示执行和覆盖完成，不表示合同无风险；partial 表示存在未完成项，不是部分条款有问题。 */
export function taskStateHint(task: Pick<ReviewTask, "state" | "error">): string {
  if (task.error?.code === "REVIEW_SCENE_UNSUPPORTED") return "当前没有适配该合同的审查场景，未生成风险结论。"
  if (task.error?.code === "REVIEW_SCENE_UNCERTAIN") return "场景尚不能确定，材料补充后可重新提交。"
  if (task.state === "success") return "执行与覆盖完成，不等于合同无风险；结论仍需人工复核。"
  if (task.state === "partial") return "存在未完成项、预算限制或材料不足，不代表部分条款本身有问题。"
  if (task.state === "failed") return "执行失败，请查看错误并重新提交。"
  return "任务尚未结束。"
}
