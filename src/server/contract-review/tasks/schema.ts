import { z } from "zod"

export const submitReviewSchema = z.object({
  documentId: z.uuid(), revisionId: z.uuid(),
  context: z.object({ scene: z.literal("auto"), role: z.literal("专业分包人"), region: z.string().trim().min(1).max(100) }).strict(),
  externalProcessingConsent: z.literal(true), unreviewedMaterialsConsent: z.boolean(), configurationId: z.string().length(64),
  generateRevision: z.boolean().optional(),
}).strict()

export const revisionTaskSchema = z.object({
  externalProcessingConsent: z.literal(true),
  ruleIds: z.array(z.string().min(1).max(100)).min(1).max(22),
}).strict()
