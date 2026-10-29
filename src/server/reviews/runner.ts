import { reviewWithAgent, type AgentReviewOptions } from "../../../tools/contract-review/src/agent"
import { loadSceneBundles, type SceneBundle } from "../../../tools/contract-review/src/bundles"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { MAX_AGENT_CALLS } from "../../../tools/contract-review/src/limits"
import { defaultSceneId } from "../../../tools/contract-review/src/scenes"
import type { ReviewResult } from "../../../tools/contract-review/src/types"
import type { ProjectReviewRunner } from "./executor"

/**
 * A4c production review runner: the existing single bounded reviewWithAgent
 * flow over the built-in scene rule packs, in explicit debug mode (the built-in
 * rules are not domain-signed; results must keep the unsigned marker).
 *
 * Round-three product decision: `auto` resolves to the default scenario
 * (mep-sub-2026) and the resolved scene is recorded in the result context.
 * Other registered scenarios must be submitted explicitly by the user.
 *
 * The model address/key come only from the server environment passed in by the
 * executor; nothing here reads browser input.
 */
export type ProjectReviewRunnerOptions = {
  loadBundles?: () => Promise<SceneBundle[]>
  /** Injected only by tests; production uses reviewWithAgent. */
  review?: (options: AgentReviewOptions) => Promise<ReviewResult>
  maxPromptChars?: number
}

export function createProjectReviewRunner(options: ProjectReviewRunnerOptions = {}): ProjectReviewRunner {
  const loadBundles = options.loadBundles ?? (() => loadSceneBundles())
  const review = options.review ?? reviewWithAgent
  return async input => {
    const requested = typeof input.context.scene === "string" ? input.context.scene.trim() : ""
    const sceneId = requested === "auto" ? defaultSceneId : requested
    const bundles = await loadBundles()
    const bundle = bundles.find(item => item.candidate.id === sceneId)
    if (!bundle) throw new ReviewError("REVIEW_SCENE_INVALID")
    if (!Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1) throw new ReviewError("REVIEW_INPUT_INVALID")
    const maxCalls = Math.min(input.maxCalls, MAX_AGENT_CALLS)
    return review({
      paragraphs: input.paragraphs.map(paragraph => ({ index: paragraph.index, text: paragraph.text, inTable: false })),
      complete: input.complete,
      documentTitle: input.documentTitle,
      documentVersionId: input.documentVersionId,
      parseSnapshotId: input.parseSnapshotId,
      context: {
        scene: bundle.candidate.id, role: input.context.role, region: input.context.region,
        projectType: bundle.candidate.label,
      },
      mode: "debug",
      pack: bundle.pack,
      skill: bundle.skill,
      maxCalls,
      maxPromptChars: options.maxPromptChars ?? 240000,
      signal: input.signal,
      env: input.env,
      onBeforeCall: reservation => input.onBeforeCall({ callNumber: reservation.callNumber }),
      onModelExchange: exchange => input.onExchange(exchange),
    })
  }
}
