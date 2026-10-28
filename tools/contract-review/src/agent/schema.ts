import { z } from "zod"

export const citationListSchema = z.array(z.object({
  paragraphIndex: z.number().int().min(0), quote: z.string().min(1).max(6000),
}).strict()).max(12)

export const findingSchema = z.object({
  ruleId: z.string().min(1).max(100),
  kind: z.enum(["发现问题", "未发现问题", "缺失条款", "待核实"]),
  risk: z.string().min(1).max(2000), severity: z.enum(["重大关注", "一般关注", "提示"]),
  quote: z.string().max(6000), paragraphIndex: z.number().int().min(-1),
  basis: z.array(z.string().min(1).max(100)).max(20), impact: z.string().max(3000),
  suggestion: z.string().min(1).max(4000), pending: z.array(z.string().min(1).max(1000)).max(20),
  citations: citationListSchema.optional(),
}).strict()

export const findingsBatchSchema = z.array(findingSchema).min(1).max(3)

export const sceneSelectionSchema = z.object({
  status: z.enum(["matched", "unsupported", "needs-confirmation"]),
  sceneId: z.string().min(1).max(100).nullable(),
  reason: z.string().trim().min(1).max(500),
  evidence: z.array(z.object({ paragraphIndex: z.number().int().min(0), quote: z.string().trim().min(1).max(2000) }).strict()).min(1).max(8),
  missingInfo: z.array(z.string().trim().min(1).max(300)).max(6),
}).strict()
