import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { readRulePackSnapshot } from "./pack"
import { revisionSkillForScene, sceneCatalog, sceneOf, type SceneCandidate, type SceneId } from "./scenes"
import { readReviewSkillSnapshot, type ReviewSkill } from "./agent/skill"
import { ReviewError } from "./errors"
import type { LoadedPack } from "./types"
import { ContentHashCache, resourceContentHash, type ResourceTextReader } from "./resource-cache"

export type SceneBundle = { candidate: SceneCandidate; pack: LoadedPack; skill: ReviewSkill; revisionSkill?: ReviewSkill; sha256: string }
const bundleCache = new ContentHashCache<SceneBundle[]>(8)
export type BundleLoadOptions = { readText?: ResourceTextReader; cache?: ContentHashCache<SceneBundle[]> }
export const bundleDigest = (bundle: Omit<SceneBundle, "sha256">) =>
  createHash("sha256").update(JSON.stringify({ candidate: bundle.candidate, pack: bundle.pack, skill: bundle.skill, revisionSkill: bundle.revisionSkill })).digest("hex")

export function validateBundles(bundles: SceneBundle[]) {
  if (!bundles.length || bundles.length > 10 || new Set(bundles.map(item => item.candidate.id)).size !== bundles.length) throw new ReviewError("REVIEW_SCENE_INVALID")
  for (const bundle of bundles) {
    if (bundle.sha256 !== bundleDigest(bundle) || bundle.candidate.skillId !== bundle.skill.id ||
      (bundle.revisionSkill && bundle.revisionSkill.id !== revisionSkillForScene[bundle.candidate.id]) ||
      !sceneCatalog().some(item => item.id === bundle.candidate.id) || !bundle.pack.rules.length ||
      bundle.pack.rules.some(rule => rule.appliesTo.scene !== bundle.candidate.id || rule.appliesTo.role !== bundle.candidate.role)) throw new ReviewError("REVIEW_SCENE_INVALID")
  }
}

/** 由部署者登记的文件装配；模型不能传路径、发布规则或组合任意资源。 */
export async function loadSceneBundles(root = process.cwd(), options: BundleLoadOptions = {}): Promise<SceneBundle[]> {
  const catalog = sceneCatalog()
  // Pin raw resources before checking the bundle cache. A hit skips parsing and all combination/digest work.
  const snapshots = await Promise.all(catalog.map(async candidate => {
    const scene = sceneOf(candidate.id as SceneId)
    const [pack, skill, revisionSkill] = await Promise.all([
      readRulePackSnapshot(resolve(root, scene.rulesDir), { readText: options.readText }),
      readReviewSkillSnapshot(resolve(root, scene.skillsRoot), candidate.skillId, { readText: options.readText }),
      readReviewSkillSnapshot(resolve(root, scene.skillsRoot), revisionSkillForScene[candidate.id], { readText: options.readText }),
    ])
    return { candidate, pack, skill, revisionSkill }
  }))
  const sha256 = resourceContentHash({ kind: "scene-bundles-v1", resources: snapshots.map(item => ({ candidate: item.candidate,
    pack: item.pack.sha256, skill: item.skill.sha256, revisionSkill: item.revisionSkill.sha256 })) })
  return (options.cache ?? bundleCache).getOrCreate(sha256, () => {
    const common = snapshots.find(item => item.candidate.id === "mep-sub-2026")!.pack.load()
    const bundles: SceneBundle[] = []
    for (const saved of snapshots) {
      const { candidate } = saved
      const skill = saved.skill.load(), revisionSkill = saved.revisionSkill.load()
      let pack = structuredClone(common)
      if (candidate.id !== "mep-sub-2026") {
        const extension = saved.pack.load()
        pack = { manifest: { ...extension.manifest, version: common.manifest.version + "+" + extension.manifest.version,
          name: candidate.label + "审查组合", status: "待核对", reviewer: null, reviewedAt: null },
          rules: [...common.rules.map(rule => ({ ...rule, status: "待核对" as const, appliesTo: { ...rule.appliesTo, scene: candidate.id } })), ...extension.rules],
          sources: [...common.sources, ...extension.sources],
          warnings: [...common.warnings, ...extension.warnings, "本场景通用与专项规则组合尚未核对，不继承原包发布资格。"] }
      }
      if (new Set(pack.rules.map(rule => rule.ruleId)).size !== pack.rules.length || new Set(pack.sources.map(source => source.sourceId)).size !== pack.sources.length) throw new ReviewError("REVIEW_RULE_PACK_INVALID")
      const value = { candidate, pack, skill, revisionSkill }
      bundles.push({ ...value, sha256: bundleDigest(value) })
    }
    validateBundles(bundles)
    return bundles
  })
}
