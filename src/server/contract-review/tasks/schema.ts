import { z } from "zod"
import { sceneIds } from "../../../../tools/contract-review/src/scenes"

export const submitReviewSchema = z.object({
  documentId: z.uuid(), revisionId: z.uuid(),
  context: z.object({ scene: z.enum(sceneIds), region: z.string().trim().min(1).max(100) }).strict(),
  externalProcessingConsent: z.literal(true), unreviewedMaterialsConsent: z.boolean(), configurationId: z.string().length(64),
}).strict()
