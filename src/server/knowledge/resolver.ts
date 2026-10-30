import type { PublishedRef } from "../../lib/business/contracts"
import { defaultSceneId, isSceneId } from "../../../tools/contract-review/src/scenes"
import type {
  PublicationResolution,
  PublicationResolver,
  PublicationResolverInput,
} from "../tasks/publications"
import { publicationDigest, rulePackFromStored } from "./content"
import { KnowledgeError } from "./errors"
import { KnowledgeRepository } from "./repository"
import type { LoadedPublishedRulePack, PublicationVersionRecord } from "./types"

/**
 * C6 publication resolver: the three-state fail-closed contract consumed by
 * `TaskService.submitTask` (W0 seam in src/server/tasks/publications.ts).
 *
 * - `pinned`: exactly one published rule-pack version exists for the resolved
 *   task scene. The refs are written into the immutable task manifest and the
 *   contract-review executor must run in published mode without file fallback.
 * - `none`: this scene never had any publication history, so the pre-existing
 *   debug/unsigned review path stays available.
 * - `blocked`: history exists but its latest version is a draft, pending,
 *   disabled or ambiguous — submission is rejected before persistence. A scene
 *   with publication history never silently downgrades to debug.
 *
 * Integrity is re-checked here: the stored payload/sources/applicability digest
 * must equal the version digest column, otherwise the resolver fails closed
 * with a service error (the task seam maps it to HTTP 503, not a debug run).
 */
const stateLabels: Record<PublicationVersionRecord["state"], string> = {
  draft: "草稿",
  pending_verification: "待核对",
  published: "已发布",
  disabled: "已停用",
}

const numericVersion = (value: string) => /^\d+$/.test(value) ? Number(value) : -1

function latestOf(versions: PublicationVersionRecord[]): PublicationVersionRecord | null {
  return [...versions].sort((left, right) => numericVersion(right.version) - numericVersion(left.version))[0] ?? null
}

function blocked(reason: string): PublicationResolution {
  return { state: "blocked", reason: reason.slice(0, 200) }
}

function refOf(version: PublicationVersionRecord): PublishedRef {
  return { id: version.publicationId, versionId: version.id, sha256: version.sha256 }
}

/** Scene used by the contract-review published basis; `auto` follows the runner default. */
export function resolveTaskScene(input: Pick<PublicationResolverInput, "kind" | "conditions">): string | null {
  if (input.kind !== "contract-review") return null
  const scene = typeof input.conditions.scene === "string" ? input.conditions.scene.trim() : ""
  if (scene === "auto") return defaultSceneId
  return isSceneId(scene) ? scene : null
}

/** Recompute the content digest from stored columns; throw on any tamper. */
export function verifyStoredVersionDigest(version: PublicationVersionRecord): void {
  let computed: string
  try {
    computed = publicationDigest(version.payload, version.sources, version.applicability)
  } catch {
    throw new KnowledgeError("SERVICE_UNAVAILABLE", "发布版本内容无法读取。")
  }
  if (computed !== version.sha256) throw new KnowledgeError("SERVICE_UNAVAILABLE", "发布版本内容与摘要不一致。")
}

export async function resolvePublicationBasis(
  repository: KnowledgeRepository,
  input: PublicationResolverInput,
): Promise<PublicationResolution> {
  const scene = resolveTaskScene(input)
  if (!scene) return { state: "none" }
  const versions = await repository.versionsForScene(scene)
  if (!versions.length) return { state: "none" }

  const byPublication = new Map<string, PublicationVersionRecord[]>()
  for (const version of versions) byPublication.set(version.publicationId, [...(byPublication.get(version.publicationId) ?? []), version])
  const current: PublicationVersionRecord[] = []
  for (const group of byPublication.values()) {
    const latest = latestOf(group)
    if (latest) current.push(latest)
  }
  // A draft/pending/disabled current version blocks the whole scene (fail-closed).
  for (const version of current) {
    if (version.state !== "published") {
      return blocked(`发布依据 ${version.kind}/${version.artifactId} 的最新版本为${stateLabels[version.state]}`)
    }
  }
  const rules = current.filter(version => version.kind === "rules")
  if (!rules.length) return blocked("该场景尚无已发布规则包")
  if (rules.length > 1) return blocked("该场景存在多个已发布规则包，发布依据不唯一")
  const knowledge = current.filter(version => version.kind === "knowledge")
  const templates = current.filter(version => version.kind === "templates")
  for (const version of [...rules, ...knowledge, ...templates]) verifyStoredVersionDigest(version)
  return {
    state: "pinned",
    pin: {
      rules: rules.map(refOf),
      knowledge: knowledge.map(refOf),
      templates: templates.map(refOf),
    },
  }
}

/** Resolver factory bound to the application database; registered only by the Node lifecycle. */
export function createPublicationResolver(provider: () => Promise<KnowledgeRepository>): PublicationResolver {
  return async input => resolvePublicationBasis(await provider(), input)
}

/**
 * Load one pinned published rule pack from its immutable database version.
 *
 * Used by the contract-review runner in published mode. A pinned version that
 * was disabled after presentation still executes its immutable content and is
 * flagged `disabled` so the result can carry the "依据已停用" warning.
 */
export async function loadPublishedRulePack(
  repository: KnowledgeRepository,
  ref: PublishedRef,
): Promise<LoadedPublishedRulePack> {
  if (!ref || typeof ref.id !== "string" || typeof ref.versionId !== "string" || !/^[a-f0-9]{64}$/.test(String(ref.sha256))) {
    throw new KnowledgeError("INVALID_CONTENT", "固定发布引用无效。")
  }
  const version = await repository.getVersion(ref.versionId)
  if (!version) throw new KnowledgeError("NOT_FOUND")
  if (version.publicationId !== ref.id || version.kind !== "rules") {
    throw new KnowledgeError("INVALID_CONTENT", "固定发布引用与发布记录不一致。")
  }
  if (version.state !== "published" && version.state !== "disabled") {
    throw new KnowledgeError("INVALID_CONTENT", "固定发布版本当前不是已发布状态。")
  }
  if (version.sha256 !== ref.sha256) throw new KnowledgeError("INVALID_CONTENT", "固定发布引用摘要不一致。")
  verifyStoredVersionDigest(version)
  const pack = rulePackFromStored(version)
  return {
    pack,
    scene: version.scene,
    disabled: version.state === "disabled",
    publicationId: version.publicationId,
    versionId: version.id,
    sha256: version.sha256,
  }
}
