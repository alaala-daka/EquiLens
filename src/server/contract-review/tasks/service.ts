import "server-only"
import { createHash } from "node:crypto"
import { documentReviewServices } from "../../documents/service"
import { StoreError } from "../../documents/repository"
import { ReviewError, safeError } from "../../../../tools/contract-review/src/errors"
import { publishedRules } from "../../../../tools/contract-review/src/pack"
import { defaultSceneId } from "../../../../tools/contract-review/src/scenes"
import { loadSceneBundles } from "../../../../tools/contract-review/src/bundles"
import type { ReviewAvailability, SubmitReview } from "../../../lib/contract-reviews/types"
import { reviewTaskConfig } from "./config"
import { ReviewTaskRepository } from "./repository"

const state = globalThis as typeof globalThis & { equilensReviewTasks?: Promise<ReviewTaskRepository> }
export function reviewTaskRepository() {
  state.equilensReviewTasks ??= documentReviewServices().then(async ({ database, sessions }) => {
    const repository = new ReviewTaskRepository(database, sessions)
    await repository.initialize()
    return repository
  }).catch(failure => { delete state.equilensReviewTasks; throw failure })
  return state.equilensReviewTasks
}

async function resources() {
  const config = reviewTaskConfig()
  // Rules and skills are explicitly copied by prepare-standalone.mjs.
  const sceneBundles = (await loadSceneBundles().catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") }))
    .filter(bundle => bundle.pack.manifest.status !== "已停用" && (config.mode === "debug" || publishedRules(bundle.pack).length > 0))
  if (!sceneBundles.length) throw new ReviewError("REVIEW_RULES_UNAVAILABLE")
  const { pack, skill } = sceneBundles.find(bundle => bundle.candidate.id === defaultSceneId) ?? sceneBundles[0]
  const packSha256 = createHash("sha256").update(JSON.stringify(pack)).digest("hex")
  const sceneCandidates = sceneBundles.map(bundle => bundle.candidate)
  const configurationId = createHash("sha256").update(JSON.stringify({ ...config, packSha256, skillSha256: skill.sha256, sceneCandidates,
    workflow: "multi-agent-v1", bundles: sceneBundles.map(bundle => bundle.sha256) })).digest("hex")
  return { config, pack, skill, packSha256, configurationId, sceneCandidates, sceneBundles }
}
export async function reviewAvailability(): Promise<ReviewAvailability> {
  try {
    const { config, configurationId } = await resources()
    return { ready: true, mode: config.mode, model: config.model, providerHost: new URL(config.baseURL).host, retentionDays: config.retentionDays, configurationId }
  } catch (failure) {
    return { ready: false, mode: process.env.AI_REVIEW_MODE === "debug" || (process.env.NODE_ENV !== "production" && !process.env.AI_REVIEW_MODE) ? "debug" : "published",
      model: "", providerHost: "", retentionDays: 0, configurationId: "", error: safeError(failure).message }
  }
}
export async function submitReview(owner: string, key: string, request: SubmitReview, contextId: string) {
  const repository = await reviewTaskRepository()
  const prior = await repository.existing(owner, key, request, contextId)
  if (prior) return prior
  const { config, pack, skill, packSha256, configurationId, sceneCandidates, sceneBundles } = await resources()
  if (configurationId !== request.configurationId) throw new StoreError(409, "模型、规则或保留配置已变化，请刷新后重新确认。")
  if (config.mode === "debug" && !request.unreviewedMaterialsConsent) throw new StoreError(422, "请确认本次使用未核对的审查资料。")
  const revision = await repository.readRevision(owner, request.documentId, request.revisionId, contextId)
  // 用户确认代表哪一方；工程场景必须在固定解析快照上由 Agent 识别。
  const context = { role: request.context.role, region: request.context.region }
  return repository.create(owner, key, request, {
    ...request, context, documentContextId: contextId, title: revision.title, revisionHash: revision.hash, mode: config.mode, model: config.model,
    baseURL: config.baseURL, maxPromptChars: config.maxPromptChars, pack, packSha256, skill, sceneCandidates, sceneBundles,
    workflow: "multi-agent-v1", auditEffort: config.auditEffort, consentAt: new Date().toISOString(),
  }, config.maxCalls, config.retentionDays)
}
