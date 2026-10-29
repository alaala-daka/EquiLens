import { createHash } from "node:crypto"
import type { ProjectReviewConditions, ProjectReviewMaterialRef, ProjectReviewScene } from "../../lib/business/contracts"
import type { MaterialRepository } from "../materials/repository"
import type { ParseCoverage } from "../materials/types"
import { ObjectStoreError, type PrivateObjectStore } from "../storage/obs"
import { parseTaskRequest } from "../tasks/catalog"
import type { ClaimedTask } from "../tasks/repository"
import { ProjectReviewError } from "./errors"

/**
 * A4c project review input assembly.
 *
 * The executor consumes only immutable project material versions and their
 * latest parse snapshots. The task manifest is treated as an input list and
 * re-read here (never trusted as a material snapshot): ownership, active
 * status, digest and retention are rechecked, then the stored object is
 * verified before any fragment is used.
 *
 * Multi-material reviews are merged into one paragraph list. `paragraphSources`
 * keeps the paragraph -> project fragment mapping used to bind every model
 * citation back to an immutable parse fragment.
 */
export type ReviewParagraph = { index: number; text: string; location: string }

export type ReviewParagraphSource = {
  fragmentId: string
  snapshotId: string
  quote: string
  location: string
  fragmentText: string
  materialId: string
}

export type ReviewMaterialInput = {
  materialId: string
  title: string
  format: "docx" | "pdf"
  versionId: string
  sha256: string
  snapshotId: string
  coverage: ParseCoverage
}

export type LoadedReviewInput = {
  paragraphs: ReviewParagraph[]
  paragraphSources: Map<number, ReviewParagraphSource>
  complete: boolean
  documentTitle: string
  documentVersionId: string
  parseSnapshotId: string
  textSha256: string
  scene: ProjectReviewScene
  role: "专业分包人"
  region: string
  asOf?: string
  unreviewedMaterialsConsent: boolean
  materials: ReviewMaterialInput[]
}

export type ReviewInputDependencies = {
  repository: Pick<MaterialRepository, "versionById" | "findMaterial" | "latestSnapshot" | "fragments">
  store: Pick<PrivateObjectStore, "get">
  /** Trusted server resolver; null means the project is missing or no longer active. */
  readProjectRetention: (projectId: string) => Promise<string | null>
  /** Fresh account/project authorization recheck, supplied by the unified runner. */
  refreshAccess: () => Promise<void>
  now?: () => Date
  /** prepareReviewInput rejects documents over 100,000 characters. */
  maxTextCharacters?: number
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/** Product retention is stored as a day; the day is inclusive up to its end (material executor parity). */
export function retentionExpired(day: string, now: Date): boolean {
  const end = Date.parse(`${day}T00:00:00Z`) + 86_400_000
  return !Number.isFinite(end) || now.getTime() >= end
}

function position(fragment: { kind: "paragraph" | "table"; order: number; page: number | null; paragraph: number | null; tableIndex: number | null; row: number | null; column: number | null }): string {
  if (fragment.kind === "table") {
    return `表格 ${fragment.tableIndex ?? "?"} 第 ${fragment.row ?? "?"} 行第 ${fragment.column ?? "?"} 列`
  }
  if (fragment.page !== null) return `第 ${fragment.page} 页`
  if (fragment.paragraph !== null) return `第 ${fragment.paragraph} 段`
  return `第 ${fragment.order + 1} 段`
}

function materialTitle(title: string): string {
  return title.length > 60 ? `${title.slice(0, 60)}…` : title
}

function reviewConditions(value: unknown): ProjectReviewConditions {
  const conditions = (value ?? {}) as Partial<ProjectReviewConditions>
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions) ||
    typeof conditions.scene !== "string" || typeof conditions.region !== "string" || !conditions.region.trim() ||
    conditions.role !== "专业分包人" || conditions.externalProcessingConsent !== true ||
    typeof conditions.unreviewedMaterialsConsent !== "boolean" ||
    (conditions.asOf !== undefined && (typeof conditions.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(conditions.asOf)))) {
    throw new ProjectReviewError("INVALID_SUBMISSION")
  }
  return conditions as ProjectReviewConditions
}

function materialReferences(value: unknown): ProjectReviewMaterialRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ProjectReviewError("INVALID_SUBMISSION")
  const refs = value.map(item => {
    const ref = (item ?? {}) as Partial<ProjectReviewMaterialRef>
    if (typeof ref.materialVersionId !== "string" || !ref.materialVersionId.trim() ||
      typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new ProjectReviewError("INVALID_SUBMISSION")
    return { materialVersionId: ref.materialVersionId, sha256: ref.sha256 }
  })
  if (new Set(refs.map(ref => ref.materialVersionId)).size !== refs.length) throw new ProjectReviewError("INVALID_SUBMISSION")
  return refs
}

async function verifyObject(deps: ReviewInputDependencies, version: { objectKey: string; sha256: string; size: number }): Promise<void> {
  let object: Awaited<ReturnType<ReviewInputDependencies["store"]["get"]>>
  try {
    object = await deps.store.get(version.objectKey)
  } catch (failure) {
    if (failure instanceof ObjectStoreError) throw new ProjectReviewError("SERVICE_UNAVAILABLE")
    throw failure
  }
  if (!object || object.sha256 !== version.sha256 || object.bytes.byteLength !== version.size ||
    createHash("sha256").update(object.bytes).digest("hex") !== version.sha256) {
    throw new ProjectReviewError("INVALID_SOURCE")
  }
}

/**
 * Re-read the task manifest, verify every material version/snapshot/object and
 * build the bounded review paragraphs plus their fragment sources.
 */
export async function loadReviewInput(deps: ReviewInputDependencies, job: ClaimedTask): Promise<LoadedReviewInput> {
  if (job.kind !== "contract-review") throw new ProjectReviewError("INVALID_SUBMISSION")
  let parsed: ReturnType<typeof parseTaskRequest>
  try {
    parsed = parseTaskRequest({ kind: job.kind, projectId: job.projectId, refs: job.manifest.refs, conditions: job.manifest.conditions })
  } catch {
    throw new ProjectReviewError("INVALID_SUBMISSION")
  }
  const refs = materialReferences((parsed.refs as { materials?: unknown }).materials)
  const conditions = reviewConditions(parsed.conditions)
  const now = deps.now?.() ?? new Date()
  const maxText = deps.maxTextCharacters ?? 100_000

  await deps.refreshAccess()
  const projectRetention = await deps.readProjectRetention(job.projectId)
  if (!projectRetention) throw new ProjectReviewError("INVALID_SOURCE")
  if (retentionExpired(projectRetention, now)) throw new ProjectReviewError("RETENTION_EXPIRED")

  const paragraphs: ReviewParagraph[] = []
  const paragraphSources = new Map<number, ReviewParagraphSource>()
  const materials: ReviewMaterialInput[] = []
  let complete = true

  for (const ref of refs) {
    await deps.refreshAccess()
    const version = await deps.repository.versionById(job.projectId, ref.materialVersionId)
    if (!version || version.sha256 !== ref.sha256) throw new ProjectReviewError("INVALID_SOURCE")
    const material = await deps.repository.findMaterial(job.projectId, version.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized) throw new ProjectReviewError("INVALID_SOURCE")
    // Contract review only consumes parsed document snapshots; certificate
    // images have no parse snapshot and are rejected here without changing any
    // existing review behavior (images were never accepted before round four).
    if (material.format === "image") throw new ProjectReviewError("INVALID_SOURCE")
    if (retentionExpired(material.retentionUntil, now)) throw new ProjectReviewError("RETENTION_EXPIRED")
    // The latest snapshot must still belong to the referenced version; a newer
    // material version invalidates this task input instead of silently reviewing it.
    const snapshot = await deps.repository.latestSnapshot(job.projectId, material.id)
    if (!snapshot || snapshot.versionId !== version.id) throw new ProjectReviewError("INVALID_SOURCE")
    if (snapshot.coverage.status === "failed") throw new ProjectReviewError("INVALID_SOURCE")
    const fragments = await deps.repository.fragments(snapshot.id)
    if (!fragments.length) throw new ProjectReviewError("INVALID_SOURCE")
    await verifyObject(deps, version)
    await deps.refreshAccess()

    if (snapshot.coverage.status !== "available") complete = false
    materials.push({ materialId: material.id, title: material.title, format: material.format,
      versionId: version.id, sha256: version.sha256, snapshotId: snapshot.id, coverage: snapshot.coverage })
    for (const fragment of fragments) {
      if (!fragment.text.trim()) continue
      const index = paragraphs.length
      const location = `${materialTitle(material.title)} ${position(fragment)}`
      paragraphs.push({ index, text: fragment.text, location })
      paragraphSources.set(index, { fragmentId: fragment.id, snapshotId: snapshot.id, quote: fragment.text,
        location, fragmentText: fragment.text, materialId: material.id })
    }
  }

  if (!paragraphs.length) throw new ProjectReviewError("INVALID_SOURCE")
  const text = paragraphs.map(item => item.text).join("\n")
  if (text.length > maxText) throw new ProjectReviewError("REVIEW_INPUT_TOO_LARGE")

  const primary = materials[0]
  const titles = materials.map(item => item.title)
  const title = (titles.length === 1 ? titles[0] : `${titles[0]} 等 ${titles.length} 份材料`).trim().slice(0, 200).trim() || "项目材料"
  return {
    paragraphs,
    paragraphSources,
    complete,
    documentTitle: title,
    documentVersionId: primary.versionId,
    parseSnapshotId: primary.snapshotId,
    textSha256: sha256(text),
    scene: conditions.scene,
    role: conditions.role,
    region: conditions.region.trim(),
    ...(conditions.asOf ? { asOf: conditions.asOf } : {}),
    unreviewedMaterialsConsent: conditions.unreviewedMaterialsConsent === true,
    materials,
  }
}
