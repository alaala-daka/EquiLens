import type { SubmitReview } from "../../lib/contract-reviews/types"
import type { ReviewTaskRepository, TaskInput } from "../contract-review/tasks/repository"
import { StoreError } from "../documents/errors"

export async function resolveLetterSources(repository: ReviewTaskRepository, owner: string, request: SubmitReview, contextId: string) {
  const sources: NonNullable<TaskInput["letterSources"]> = {}
  let notAfter: string | undefined
  for (const [kind, id] of [["payment", request.paymentTaskId], ["evidence", request.evidenceTaskId]] as const) {
    if (!id) continue
    const source = await repository.sourceReview(owner, id, contextId)
    const expected = kind === "payment" ? "payment-reconciliation" : "evidence-organization"
    if (source.input.documentId !== request.documentId || source.input.revisionId !== request.revisionId || source.input.asOf !== request.asOf || source.result.documentAnalysis?.task !== expected) throw new StoreError(409, "所选资料成果必须对应当前保存版本及核对截止日。")
    sources[kind] = { taskId: id, result: source.result }
    notAfter = !notAfter || source.expiresAt < notAfter ? source.expiresAt : notAfter
  }
  return { sources, notAfter }
}
