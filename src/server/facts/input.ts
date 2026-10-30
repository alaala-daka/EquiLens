import { createHash } from "node:crypto"
import { BusinessError } from "../projects/errors"
import type { ReviewInputDependencies } from "../reviews/input"
import { retentionExpired } from "../reviews/input"
import { parseTaskRequest } from "../tasks/catalog"
import type { ClaimedTask } from "../tasks/repository"
import type { FactCandidatesValue } from "./result-validator"

export type FactsInput = {
  cutoff?: string
  complete: boolean
  materials: FactCandidatesValue["materials"]
  paragraphs: Array<{ snapshotId: string; fragmentId: string; text: string }>
}
export type FactsInputDependencies = ReviewInputDependencies
const invalid = () => new BusinessError("INVALID_SOURCE", "事实准备材料无效或已过期。")

export async function loadFactsInput(job: ClaimedTask, deps: FactsInputDependencies): Promise<FactsInput> {
  if (job.kind !== "document-analysis") throw new BusinessError("INVALID_INPUT", "事实准备任务类型无效。")
  const parsed = parseTaskRequest({ kind: job.kind, projectId: job.projectId, refs: job.manifest.refs, conditions: job.manifest.conditions })
  const refs = parsed.refs.materials as Array<{ materialVersionId: string; sha256: string }>
  const now = deps.now?.() ?? new Date()
  await deps.refreshAccess()
  const retention = await deps.readProjectRetention(job.projectId)
  if (!retention || retentionExpired(retention, now)) throw invalid()
  const value: FactsInput = { complete: true, materials: [], paragraphs: [], ...(parsed.conditions.asOf ? { cutoff: String(parsed.conditions.asOf) } : {}) }
  for (const ref of refs) {
    await deps.refreshAccess()
    const version = await deps.repository.versionById(job.projectId, ref.materialVersionId)
    if (!version || version.sha256 !== ref.sha256) throw invalid()
    const material = await deps.repository.findMaterial(job.projectId, version.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized || retentionExpired(material.retentionUntil, now)) throw invalid()
    const snapshot = await deps.repository.latestSnapshot(job.projectId, material.id)
    if (!snapshot || snapshot.versionId !== version.id || snapshot.coverage.status === "failed") throw invalid()
    const fragments = await deps.repository.fragments(snapshot.id)
    if (!fragments.length) throw invalid()
    const object = await deps.store.get(version.objectKey)
    if (!object || object.sha256 !== version.sha256 || object.bytes.byteLength !== version.size || createHash("sha256").update(object.bytes).digest("hex") !== version.sha256) throw invalid()
    value.materials.push({ materialId: material.id, materialVersionId: version.id, snapshotId: snapshot.id, sha256: version.sha256, title: material.title })
    if (snapshot.coverage.status !== "available") value.complete = false
    for (const fragment of fragments) if (fragment.text.trim()) value.paragraphs.push({ snapshotId: snapshot.id, fragmentId: fragment.id, text: fragment.text })
  }
  if (!value.paragraphs.length) throw invalid()
  if (value.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) > (deps.maxTextCharacters ?? 55000))
    throw new BusinessError("INVALID_INPUT", "事实准备材料超过处理上限，请减少所选材料。")
  return value
}
