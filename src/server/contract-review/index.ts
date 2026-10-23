import "server-only"
import { resolve } from "node:path"
import { paragraphsFromString } from "../../../tools/contract-review/src/document"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { createGatewayAskModel } from "../../../tools/contract-review/src/gateway"
import { loadRulePack } from "../../../tools/contract-review/src/pack"
import { defaultSceneId, sceneOf } from "../../../tools/contract-review/src/scenes"
import { reviewContract, type ReviewOptions } from "../../../tools/contract-review/src/review"
import { buildSegments } from "../../../tools/contract-review/src/segments"
import { reviewWithAgent, type AgentSettings } from "../../../tools/contract-review/src/agent"
import type { ReviewInput } from "../../../tools/contract-review/src/input"
import type { Paragraph } from "../../../tools/contract-review/src/types"

export type { ReviewResult, ReviewContext } from "../../../tools/contract-review/src/types"
export type { AgentProgress } from "../../../tools/contract-review/src/agent"
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
  const maxPromptChars = configured ? Number(configured) : 240000
  const pack = await loadRulePack(resolve(process.cwd(), sceneOf(defaultSceneId).rulesDir))
    .catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") })
  // 按条款块定向取材：每批只送相关块与全文目录，长合同不再因整篇超限而失败。
  const segments = buildSegments(paragraphsFromString(input.documentText))
  return reviewContract({
    ...input, ...settings, pack, maxPromptChars, segments,
    model: createGatewayAskModel(), modelName: process.env.AI_MODEL?.trim() || "glm-5.3-flash",
  })
}

/** 可信后端设置；禁止直接展开客户端参数。与旧入口分开迁移。 */
export type AgentReviewSettings = Omit<AgentSettings, "maxPromptChars">

async function runAgent(input: ReviewInput, settings: AgentReviewSettings) {
  const snapshot = structuredClone(input)
  const configured = process.env.AI_REVIEW_MAX_PROMPT_CHARS?.trim()
  if ((snapshot.mode ?? "published") === "published" && !configured) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const pack = await loadRulePack(resolve(process.cwd(), sceneOf(defaultSceneId).rulesDir))
    .catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") })
  return reviewWithAgent({
    ...snapshot, ...settings, pack, maxPromptChars: configured ? Number(configured) : 240000,
    maxCalls: settings.maxCalls ?? Number(process.env.AI_AGENT_MAX_CALLS ?? 25),
  })
}

export function reviewTextWithAgent(input: ReviewTextInput, settings: AgentReviewSettings = {}) {
  return runAgent(input, settings)
}

/** 已有解析快照的任务走此入口，保留原始段落编号和表格行列信息。 */
export function reviewSnapshotWithAgent(
  input: Omit<ReviewInput, "documentText"> & { paragraphs: Paragraph[] }, settings: AgentReviewSettings = {},
) {
  return runAgent(input, settings)
}
