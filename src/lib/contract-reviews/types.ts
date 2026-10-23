import type { ReviewResult, ReviewContext } from "../../../tools/contract-review/src/types"
export type { ReviewResult, ReviewContext }
export type ReviewTaskState = "queued" | "running" | "success" | "partial" | "failed"
export type ReviewTask = {
  id: string; documentId: string; revisionId: string; title: string; state: ReviewTaskState; stage: string
  createdAt: string; updatedAt: string; expiresAt: string; attempt: number; callsUsed: number; maxCalls: number
  progress: { readParagraphCount: number; paragraphCount: number; submittedRuleCount: number }
  error: { code: string; message: string } | null
  result?: ReviewResult | null
}
export type ReviewAvailability = {
  ready: boolean; mode: "published" | "debug"; model: string; providerHost: string; retentionDays: number; configurationId: string; error?: string
}
export type SubmitReview = {
  documentId: string; revisionId: string; context: ReviewContext
  externalProcessingConsent: true; unreviewedMaterialsConsent: boolean
  configurationId: string
}
export const taskStateLabel: Record<ReviewTaskState, string> = {
  queued: "排队中", running: "处理中", success: "已完成", partial: "部分完成", failed: "失败",
}
export const taskStageLabel: Record<string, string> = {
  queued: "等待处理", parsing: "解析文档", prepared: "准备审查", reviewing: "审查条款",
  validating: "校验结果", completed: "处理结束", recovering: "恢复排队", cancelled: "已取消", failed: "处理失败",
}
