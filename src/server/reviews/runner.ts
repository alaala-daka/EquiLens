import type { PublishedRef } from "../../lib/business/contracts"
import { reviewWithAgent, type AgentReviewOptions } from "../../../tools/contract-review/src/agent"
import { loadSceneBundles, type SceneBundle } from "../../../tools/contract-review/src/bundles"
import { ReviewError } from "../../../tools/contract-review/src/errors"
import { MAX_AGENT_CALLS } from "../../../tools/contract-review/src/limits"
import { defaultSceneId } from "../../../tools/contract-review/src/scenes"
import type { LoadedPack, ReviewResult } from "../../../tools/contract-review/src/types"
import type { ProjectReviewRunner, ProjectReviewRunnerInput, PublishedReviewResult } from "./executor"

/**
 * One pinned published rule pack loaded from the business database (C6).
 * `disabled` means the immutable version was retired after task submission.
 */
export type PublishedRulePack = {
  pack: LoadedPack
  scene: string
  disabled: boolean
}

export const RETIRED_BASIS_WARNING = "依据已停用：本次任务按提交时固定的发布版本执行；该版本已停用，新提交不再接受此依据。"

/**
 * A4c production review runner.
 *
 * Without a pinned published basis it keeps the existing debug/unsigned path
 * over the built-in scene rule packs. With a `publications` pin (C6) it must run
 * `mode:"published"` using only the pinned database pack — there is no fallback
 * to file rules, and a missing/invalid pinned pack fails the task instead of
 * silently downgrading. The runner embeds the fixed `PublishedRef` list in the
 * result value so the result validator can require an explicit verified basis
 * for published mode.
 *
 * The model address/key come only from the server environment passed in by the
 * executor; nothing here reads browser input.
 */
export type ProjectReviewRunnerOptions = {
  loadBundles?: () => Promise<SceneBundle[]>
  /** Injected only by tests; production uses reviewWithAgent. */
  review?: (options: AgentReviewOptions) => Promise<ReviewResult>
  maxPromptChars?: number
  /** Database-backed loader (C6); required for pinned published tasks. */
  loadPublishedPack?: (ref: PublishedRef) => Promise<PublishedRulePack>
}

export function createProjectReviewRunner(options: ProjectReviewRunnerOptions = {}): ProjectReviewRunner {
  const loadBundles = options.loadBundles ?? (() => loadSceneBundles())
  const review = options.review ?? reviewWithAgent
  return async (input: ProjectReviewRunnerInput) => {
    const requested = typeof input.context.scene === "string" ? input.context.scene.trim() : ""
    const sceneId = requested === "auto" ? defaultSceneId : requested
    if (input.published) {
      const refs = input.published.rules
      if (!Array.isArray(refs) || refs.length !== 1 || !options.loadPublishedPack) throw new ReviewError("REVIEW_RULE_PACK_INVALID")
      let loaded: PublishedRulePack
      try {
        loaded = await options.loadPublishedPack(refs[0])
      } catch {
        throw new ReviewError("REVIEW_RULE_PACK_INVALID")
      }
      if (loaded.scene !== sceneId) throw new ReviewError("REVIEW_SCENE_INVALID")
      if (loaded.pack.manifest.status !== "已发布") throw new ReviewError("REVIEW_RULE_PACK_INVALID")
      const bundles = await loadBundles()
      const bundle = bundles.find(item => item.candidate.id === loaded.scene)
      if (!bundle) throw new ReviewError("REVIEW_SCENE_INVALID")
      if (!Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1) throw new ReviewError("REVIEW_INPUT_INVALID")
      const maxCalls = Math.min(input.maxCalls, MAX_AGENT_CALLS)
      const reviewed = await review({
        paragraphs: input.paragraphs.map(paragraph => ({ index: paragraph.index, text: paragraph.text, inTable: false })),
        complete: input.complete,
        documentTitle: input.documentTitle,
        documentVersionId: input.documentVersionId,
        parseSnapshotId: input.parseSnapshotId,
        context: {
          scene: bundle.candidate.id, role: input.context.role, region: input.context.region,
          projectType: bundle.candidate.label,
        },
        mode: "published",
        pack: loaded.pack,
        skill: bundle.skill,
        maxCalls,
        maxPromptChars: options.maxPromptChars ?? 240000,
        signal: input.signal,
        env: input.env,
        onBeforeCall: reservation => input.onBeforeCall({ callNumber: reservation.callNumber }),
        onModelExchange: exchange => input.onExchange(exchange),
      })
      const result = reviewed as PublishedReviewResult
      // The immutable pinned refs are embedded in the saved value: a bare
      // `mode:"published"` claim without them stays invalid.
      result.publicationBasis = {
        rules: refs.map(ref => ({ ...ref })),
        knowledge: (input.published.knowledge ?? []).map(ref => ({ ...ref })),
      }
      if (loaded.disabled && !result.warnings.includes(RETIRED_BASIS_WARNING)) {
        result.warnings = [RETIRED_BASIS_WARNING, ...result.warnings]
      }
      return result
    }
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
