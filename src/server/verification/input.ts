import { createHash } from "node:crypto"
import type {
  ExternalRecordSnapshot, RequirementSnapshot, RequirementSetValue,
} from "../../lib/business/verification-types"
import { quotesMatch } from "../../lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import { type BusinessError, isBusinessError } from "../projects/errors"
import type { MaterialRepository } from "../materials/repository"
import type { ResultAuthorizer, ResultService, ResultSource } from "../results/service"
import { parseTaskRequest } from "../tasks/catalog"
import type { ClaimedTask } from "../tasks/repository"
import type { FieldSource, VerificationFieldValue } from "./field-source"
import {
  assertReadyForComparison, inspectRequirementSet, requirementSetSnapshot,
} from "./requirements"
import { retentionExpired } from "../reviews/input"
import type { VerificationRecordRepository } from "./records-repository"
import { VerificationError, record, recordSha256, text } from "./types"

/**
 * C4-VERIFY task input assembly (plan §4.7/§5 `input.ts`).
 *
 * The task manifest is treated only as an input list. Every comparison re-reads
 * the selected requirement-set result version through the project-scoped result
 * service, re-reads each requirement's material version / snapshot / fragment and
 * re-checks every quote verbatim, re-reads the compared material versions, the
 * current field values and exactly the pinned external records. Cross-project,
 * deleted, digest-mismatched or unconfirmed inputs fail before any result write.
 */
export type LoadedBidVerificationInput = {
  asOf: string
  requirementSet: { resultId: string; versionId: string; sha256: string; value: RequirementSetValue }
  requirements: RequirementSnapshot[]
  /** Verbatim project fragments backing every requirement quote (for the result `sources`). */
  requirementSources: ResultSource[]
  materials: Array<{ materialId: string; title: string; versionId: string; sha256: string }>
  fieldValues: VerificationFieldValue[]
  records: ExternalRecordSnapshot[]
}

export type BidVerificationInputDependencies = {
  repository: Pick<MaterialRepository, "versionById" | "findMaterial" | "findSnapshot" | "findFragment">
  records: Pick<VerificationRecordRepository, "findById">
  results: Pick<ResultService, "get">
  fieldSource: FieldSource
  /** Trusted server resolver; null means the project is missing or no longer active. */
  readProjectRetention: (projectId: string) => Promise<string | null>
  refreshAccess: () => Promise<void>
  identity: AuthIdentity
  authorize: ResultAuthorizer
  now?: () => Date
}

export type BidVerificationRefs = {
  materials: Array<{ materialVersionId: string; sha256: string }>
  requirementSet: { id: string; versionId: string; sha256: string }
  externalRecords: Array<{ recordId: string; sha256: string }>
}

function fail(): never {
  throw new VerificationError("INVALID_SOURCE")
}

async function activeMaterial(
  deps: Pick<BidVerificationInputDependencies, "repository" | "now">,
  projectId: string,
  versionId: string,
): Promise<{ materialId: string; title: string; versionId: string; sha256: string }> {
  const version = await deps.repository.versionById(projectId, versionId)
  if (!version) fail()
  const material = await deps.repository.findMaterial(projectId, version.materialId)
  if (!material || material.status !== "active" || !material.processingAuthorized) fail()
  if (retentionExpired(material.retentionUntil, deps.now?.() ?? new Date())) throw new VerificationError("RETENTION_EXPIRED")
  return { materialId: material.id, title: material.title, versionId: version.id, sha256: version.sha256 }
}

function verificationRefs(value: Record<string, unknown>): BidVerificationRefs {
  const materials = Array.isArray(value.materials) ? value.materials : []
  const parsedMaterials = materials.map(item => {
    const ref = record(item)
    if (!ref || typeof ref.materialVersionId !== "string" || typeof ref.sha256 !== "string") fail()
    return { materialVersionId: ref.materialVersionId, sha256: ref.sha256 }
  })
  const set = record(value.requirementSet)
  if (!set || typeof set.id !== "string" || typeof set.versionId !== "string" || typeof set.sha256 !== "string") fail()
  const external = Array.isArray(value.externalRecords) ? value.externalRecords : []
  const parsedExternal = external.map(item => {
    const ref = record(item)
    if (!ref || typeof ref.recordId !== "string" || typeof ref.sha256 !== "string") fail()
    return { recordId: ref.recordId, sha256: ref.sha256 }
  })
  if (!parsedMaterials.length) fail()
  return {
    materials: parsedMaterials,
    requirementSet: { id: set.id, versionId: set.versionId, sha256: set.sha256 },
    externalRecords: parsedExternal,
  }
}

/** Re-read the full comparison input from the manifest; throws controlled verification failures only. */
export async function loadBidVerificationInput(job: ClaimedTask, deps: BidVerificationInputDependencies): Promise<LoadedBidVerificationInput> {
  if (job.kind !== "bid-verification") throw new VerificationError("INVALID_SUBMISSION")
  let parsed: ReturnType<typeof parseTaskRequest>
  try {
    parsed = parseTaskRequest({ kind: job.kind, projectId: job.projectId, refs: job.manifest.refs, conditions: job.manifest.conditions })
  } catch { throw new VerificationError("INVALID_SUBMISSION") }
  const refs = verificationRefs(parsed.refs)
  const conditions = parsed.conditions
  const asOf = text(conditions.asOf)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new VerificationError("INVALID_SUBMISSION")
  const now = deps.now?.() ?? new Date()

  await deps.refreshAccess()
  const projectRetention = await deps.readProjectRetention(job.projectId)
  if (!projectRetention) throw new VerificationError("INVALID_SOURCE")
  if (retentionExpired(projectRetention, now)) throw new VerificationError("RETENTION_EXPIRED")

  // 1. Project-scoped requirement-set version (cross-project/unknown → NOT_FOUND here).
  let setView: Awaited<ReturnType<BidVerificationInputDependencies["results"]["get"]>>
  try {
    setView = await deps.results.get(deps.identity, deps.authorize, job.projectId, refs.requirementSet.id, refs.requirementSet.versionId)
  } catch (failure) {
    if (isBusinessError(failure) && (failure as BusinessError).code === "NOT_FOUND") fail()
    throw failure
  }
  if (setView.kind !== "bid-requirements") fail()
  if (setView.versionId !== refs.requirementSet.versionId || setView.sha256 !== refs.requirementSet.sha256) fail()
  const inspected = inspectRequirementSet(setView.value)
  if (!inspected.value) throw new VerificationError("REQUIREMENT_SET_INVALID")
  if (inspected.issues.length) throw new VerificationError("REQUIREMENT_SET_INVALID")
  const setValue = inspected.value
  const readiness = assertReadyForComparison(setValue)
  if (!readiness.ok) throw new VerificationError("REQUIREMENT_SET_NOT_READY")

  // 2. Re-read every requirement source fragment verbatim in the project.
  const requirementSources: ResultSource[] = []
  const requirementMaterials: Array<{ materialId: string; title: string; versionId: string; sha256: string }> = []
  const seenVersionIds = new Set<string>()
  const seenSources = new Set<string>()
  for (const requirement of setValue.requirements) {
    await deps.refreshAccess()
    const version = await deps.repository.versionById(job.projectId, requirement.materialVersionId)
    if (!version) fail()
    const material = await deps.repository.findMaterial(job.projectId, version.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized) fail()
    if (retentionExpired(material.retentionUntil, now)) throw new VerificationError("RETENTION_EXPIRED")
    const snapshot = await deps.repository.findSnapshot(job.projectId, requirement.source.snapshotId)
    if (!snapshot || snapshot.materialId !== version.materialId || snapshot.versionId !== version.id) fail()
    const fragment = await deps.repository.findFragment(job.projectId, snapshot.id, requirement.source.fragmentId)
    if (!fragment || !quotesMatch(fragment.text, requirement.quote)) fail()
    const sourceKey = `${snapshot.id}:${fragment.id}`
    if (!seenSources.has(sourceKey)) {
      seenSources.add(sourceKey)
      requirementSources.push({ fragmentId: fragment.id, snapshotId: snapshot.id, quote: fragment.text })
    }
    if (!seenVersionIds.has(version.id)) {
      seenVersionIds.add(version.id)
      requirementMaterials.push({ materialId: material.id, title: material.title, versionId: version.id, sha256: version.sha256 })
    }
  }

  // 3. Compared material versions: ownership, digest, active status and retention.
  const materials: Array<{ materialId: string; title: string; versionId: string; sha256: string }> = []
  const comparedVersionIds: string[] = []
  for (const ref of refs.materials) {
    await deps.refreshAccess()
    const loaded = await activeMaterial(deps, job.projectId, ref.materialVersionId)
    if (loaded.sha256 !== ref.sha256) fail()
    if (!seenVersionIds.has(loaded.versionId)) {
      seenVersionIds.add(loaded.versionId)
      materials.push(loaded)
      comparedVersionIds.push(loaded.versionId)
    }
  }
  if (!materials.length) fail()
  const versionMaterial = new Map<string, string>()
  for (const material of materials) {
    const version = await deps.repository.versionById(job.projectId, material.versionId)
    if (!version || version.materialId !== material.materialId) fail()
    versionMaterial.set(version.id, version.materialId)
  }

  // 4. Current field values from the C4-OCR/manual field source (no direct DB read).
  const fieldValues = await deps.fieldSource.values(job.projectId, comparedVersionIds)
  const materialVersionIds = new Set(materials.map(material => material.versionId))
  for (const fieldValue of fieldValues) {
    if (!fieldValue || !materialVersionIds.has(fieldValue.versionId)) fail()
    if (versionMaterial.get(fieldValue.versionId) !== fieldValue.materialId) fail()
    if (typeof fieldValue.valueText !== "string" || !fieldValue.valueText.trim() || typeof fieldValue.subjectKey !== "string" || !fieldValue.subjectKey.trim()) fail()
  }

  // 5. Exactly the pinned external records; no implicit read of later appends.
  const records: ExternalRecordSnapshot[] = []
  const requirementIds = new Set(setValue.requirements.map(requirement => requirement.requirementId))
  const seenRecords = new Set<string>()
  for (const ref of refs.externalRecords) {
    const stored = await deps.records.findById(job.projectId, ref.recordId)
    if (!stored || stored.requirementSetVersionId !== refs.requirementSet.versionId) fail()
    if (stored.sha256 !== ref.sha256 || recordSha256(stored) !== stored.sha256 || !requirementIds.has(stored.requirementId)) fail()
    await deps.refreshAccess()
    await activeMaterial(deps, job.projectId, stored.proofMaterialVersionId)
    if (seenRecords.has(stored.recordId)) continue
    seenRecords.add(stored.recordId)
    records.push({
      recordId: stored.recordId,
      sha256: stored.sha256,
      requirementId: stored.requirementId,
      subject: stored.subject,
      certificateNo: stored.certificateNo,
      source: stored.source,
      queriedAt: stored.queriedAt,
      queryConditions: stored.queryConditions,
      conclusion: stored.conclusion,
      proofMaterialVersionId: stored.proofMaterialVersionId,
    })
  }

  return {
    asOf,
    requirementSet: {
      resultId: setView.resultId,
      versionId: setView.versionId,
      sha256: setView.sha256,
      value: setValue,
    },
    requirements: requirementSetSnapshot(setValue),
    requirementSources,
    materials,
    fieldValues,
    records,
  }
}

/** Everything the bid-requirements extractor may read; only immutable project text. */
export type LoadedBidRequirementsInput = {
  asOf?: string
  complete: boolean
  materials: Array<{ materialId: string; title: string; versionId: string; sha256: string }>
  paragraphs: Array<{ fragmentId: string; snapshotId: string; materialVersionId: string; text: string }>
}

export type BidRequirementsInputDependencies = {
  repository: Pick<MaterialRepository, "versionById" | "findMaterial" | "latestSnapshot" | "fragments">
  readProjectRetention: (projectId: string) => Promise<string | null>
  refreshAccess: () => Promise<void>
  now?: () => Date
  /** Combined tender text cap; over-limit fails instead of being truncated. */
  maxTextCharacters?: number
}

export async function loadBidRequirementsInput(job: ClaimedTask, deps: BidRequirementsInputDependencies): Promise<LoadedBidRequirementsInput> {
  if (job.kind !== "bid-requirements") throw new VerificationError("INVALID_SUBMISSION")
  let parsed: ReturnType<typeof parseTaskRequest>
  try {
    parsed = parseTaskRequest({ kind: job.kind, projectId: job.projectId, refs: job.manifest.refs, conditions: job.manifest.conditions })
  } catch { throw new VerificationError("INVALID_SUBMISSION") }
  const rawMaterials = Array.isArray(parsed.refs.materials) ? parsed.refs.materials : null
  if (!rawMaterials || !rawMaterials.length) throw new VerificationError("INVALID_SUBMISSION")
  const refs = rawMaterials.map(item => {
    const ref = record(item)
    if (!ref || typeof ref.materialVersionId !== "string" || typeof ref.sha256 !== "string") throw new VerificationError("INVALID_SUBMISSION")
    return { materialVersionId: ref.materialVersionId, sha256: ref.sha256 }
  })
  const asOf = typeof parsed.conditions.asOf === "string" ? parsed.conditions.asOf : undefined
  const now = deps.now?.() ?? new Date()

  await deps.refreshAccess()
  const projectRetention = await deps.readProjectRetention(job.projectId)
  if (!projectRetention) throw new VerificationError("INVALID_SOURCE")
  if (retentionExpired(projectRetention, now)) throw new VerificationError("RETENTION_EXPIRED")

  const materials: LoadedBidRequirementsInput["materials"] = []
  const paragraphs: LoadedBidRequirementsInput["paragraphs"] = []
  let complete = true
  for (const ref of refs) {
    await deps.refreshAccess()
    const version = await deps.repository.versionById(job.projectId, ref.materialVersionId)
    if (!version || version.sha256 !== ref.sha256) throw new VerificationError("INVALID_SOURCE")
    const material = await deps.repository.findMaterial(job.projectId, version.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized) throw new VerificationError("INVALID_SOURCE")
    if (retentionExpired(material.retentionUntil, now)) throw new VerificationError("RETENTION_EXPIRED")
    const snapshot = await deps.repository.latestSnapshot(job.projectId, material.id)
    if (!snapshot || snapshot.versionId !== version.id) throw new VerificationError("INVALID_SOURCE")
    if (snapshot.coverage.status === "failed") throw new VerificationError("INVALID_SOURCE")
    const fragments = await deps.repository.fragments(snapshot.id)
    if (!fragments.length) throw new VerificationError("INVALID_SOURCE")
    if (snapshot.coverage.status !== "available") complete = false
    materials.push({ materialId: material.id, title: material.title, versionId: version.id, sha256: version.sha256 })
    for (const fragment of fragments) {
      if (!fragment.text.trim()) continue
      paragraphs.push({ fragmentId: fragment.id, snapshotId: snapshot.id, materialVersionId: version.id, text: fragment.text })
    }
  }
  if (!paragraphs.length) throw new VerificationError("INVALID_SOURCE")
  const textLength = paragraphs.map(paragraph => paragraph.text).join("\n").length
  if (textLength > (deps.maxTextCharacters ?? 120_000)) throw new VerificationError("INVALID_SOURCE")
  return { ...(asOf ? { asOf } : {}), complete, materials, paragraphs }
}

/** Deterministic hash used only for tests/diagnostics of loaded inputs. */
export function inputDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
