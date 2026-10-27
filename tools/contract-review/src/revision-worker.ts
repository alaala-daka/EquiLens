import { buildRevisionDocx } from "./revision-docx"
import type { ReviewResult } from "./types"
import type { RevisionState, RevisionAudit } from "./revision"

process.once("message", (message: { bytes: string; primary: ReviewResult; draft: RevisionState; audit: RevisionAudit }) => {
  try {
    const output = buildRevisionDocx(Buffer.from(message.bytes, "base64"), message.primary, message.draft, message.audit)
    process.send?.({ valid: true, bytes: Buffer.from(output).toString("base64") }, () => process.exit(0))
  } catch { process.send?.({ valid: false }, () => process.exit(0)) }
})
