import { z } from "zod"
import { daySchema, letterPlanSchema } from "../../document-agent/schema"

export const submitReviewSchema = z.object({
  documentId: z.uuid(), revisionId: z.uuid(),
  task: z.enum(["contract-review", "payment-reconciliation", "evidence-organization", "collection-letter"]).optional(), asOf: daySchema.optional(),
  letterPlan: letterPlanSchema.optional(), paymentTaskId: z.uuid().optional(), evidenceTaskId: z.uuid().optional(),
  context: z.object({ scene: z.literal("auto"), role: z.literal("专业分包人"), region: z.string().trim().max(100) }).strict(),
  externalProcessingConsent: z.literal(true), unreviewedMaterialsConsent: z.boolean(), configurationId: z.string().length(64),
  generateRevision: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  const business = input.task && input.task !== "contract-review"
  if (business && (!input.asOf || input.generateRevision)) context.addIssue({ code: "custom", message: "资料整理需截止日且不能生成合同修订稿。" })
  if (!business && !input.context.region) context.addIssue({ code: "custom", message: "合同审查需地域。" })
  if (input.task === "collection-letter" && !input.letterPlan) context.addIssue({ code: "custom", message: "催款函需确认拟发送计划。" })
  if (input.task !== "collection-letter" && (input.letterPlan || input.paymentTaskId || input.evidenceTaskId)) context.addIssue({ code: "custom", message: "当前任务不能提交催款函输入。" })
})

export const revisionTaskSchema = z.object({
  externalProcessingConsent: z.literal(true),
  ruleIds: z.array(z.string().min(1).max(100)).min(1).max(22),
}).strict()
