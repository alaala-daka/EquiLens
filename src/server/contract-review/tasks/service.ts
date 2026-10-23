import "server-only"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { documentReviewServices } from "../../documents/service"
import { StoreError } from "../../documents/repository"
import { ReviewError, safeError } from "../../../../tools/contract-review/src/errors"
import { loadRulePack, publishedRules } from "../../../../tools/contract-review/src/pack"
import { loadReviewSkill } from "../../../../tools/contract-review/src/agent/skill"
import { defaultSceneId, sceneContext, sceneOf } from "../../../../tools/contract-review/src/scenes"
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
  const pack = await loadRulePack(resolve(/* turbopackIgnore: true */ process.cwd(), sceneOf(defaultSceneId).rulesDir))
    .catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") })
  const skill = await loadReviewSkill(resolve(/* turbopackIgnore: true */ process.cwd(), sceneOf(defaultSceneId).skillsRoot))
  if (pack.manifest.status === "已停用" || (config.mode === "published" && !publishedRules(pack).length)) throw new ReviewError("REVIEW_RULES_UNAVAILABLE")
  const packSha256 = createHash("sha256").update(JSON.stringify(pack)).digest("hex")
  const configurationId = createHash("sha256").update(JSON.stringify({ ...config, packSha256, skillSha256: skill.sha256 })).digest("hex")
  return { config, pack, skill, packSha256, configurationId }
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
  const { config, pack, skill, packSha256, configurationId } = await resources()
  if (configurationId !== request.configurationId) throw new StoreError(409, "模型、规则或保留配置已变化，请刷新后重新确认。")
  if (config.mode === "debug" && !request.unreviewedMaterialsConsent) throw new StoreError(422, "请确认本次使用未核对的审查资料。")
  const revision = await repository.readRevision(owner, request.documentId, request.revisionId, contextId)
  // 立场与项目名称由场景表给出，客户端只能选择已登记的场景。
  const context = sceneContext(request.context.scene, request.context.region)
  if (!pack.rules.some(rule => rule.appliesTo.scene === context.scene)) throw new ReviewError("REVIEW_CONTEXT_UNMATCHED")
  return repository.create(owner, key, request, {
    ...request, context, documentContextId: contextId, title: revision.title, revisionHash: revision.hash, mode: config.mode, model: config.model,
    baseURL: config.baseURL, maxPromptChars: config.maxPromptChars, pack, packSha256, skill, consentAt: new Date().toISOString(),
  }, config.maxCalls, config.retentionDays)
}
