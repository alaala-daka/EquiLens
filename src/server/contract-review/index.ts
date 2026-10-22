import "server-only"
import { resolve } from "node:path"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { createGatewayAskModel } from "../../../tools/contract-review/src/gateway"
import { loadRulePack } from "../../../tools/contract-review/src/pack"
import { reviewContract, type ReviewOptions } from "../../../tools/contract-review/src/review"

export type { ReviewResult, ReviewContext } from "../../../tools/contract-review/src/types"
export { ReviewError } from "../../../tools/contract-review/src/errors"

export type ReviewTextInput = Pick<ReviewOptions,
  "documentTitle" | "documentVersionId" | "parseSnapshotId" | "context" | "complete" | "mode">
  & { documentText: string }

/** 参数只能由可信后端设置，禁止将客户端传来的对象直接展开为 settings。 */
export type ReviewTextSettings = Pick<ReviewOptions,
  "signal" | "onBeforeCall" | "callsUsed" | "timeoutMs" | "batchSize">

/** 调用方先完成项目授权、文档版本读取及任务预算恢复，再调用此入口。 */
export async function reviewText(input: ReviewTextInput, settings: ReviewTextSettings = {}) {
  const configured = process.env.AI_REVIEW_MAX_PROMPT_CHARS?.trim()
  if ((input.mode ?? "published") === "published" && !configured) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const maxPromptChars = configured ? Number(configured) : 24000
  const pack = await loadRulePack(resolve(process.cwd(), "tools/contract-review/rules"))
    .catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") })
  return reviewContract({
    ...input, ...settings, pack, maxPromptChars,
    model: createGatewayAskModel(), modelName: process.env.AI_MODEL?.trim() || "glm-5.3-flash",
  })
}
