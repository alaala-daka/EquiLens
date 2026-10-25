import { z } from "zod"

export const submitReviewSchema = z.object({
  documentId: z.uuid(), revisionId: z.uuid(),
  context: z.object({ scene: z.literal("auto"), role: z.literal("专业分包人"), region: z.string().trim().min(1).max(100) }).strict(),
  externalProcessingConsent: z.literal(true), unreviewedMaterialsConsent: z.boolean(), configurationId: z.string().length(64),
}).strict()
