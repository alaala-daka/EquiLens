import { createHash, randomUUID } from "node:crypto"
import type { TaskExecutor } from "../tasks/runner-core"
import type { PrivateObjectStore } from "../storage/obs"
import type { MaterialRepository } from "./repository"
import { parseInSubprocess } from "./parser-process"

export function createMaterialExecutor(deps: { repository: MaterialRepository; store: PrivateObjectStore; parse?: typeof parseInSubprocess; now?: () => Date; readProjectRetention: (projectId: string) => Promise<string | null> }): TaskExecutor {
  return async (job, context) => {
    const refs = job.manifest.refs.materials as { materialVersionId: string; sha256: string }[]
    if (job.kind !== "material-parse" || !Array.isArray(refs) || refs.length < 1 || refs.length > 10) throw new Error("INVALID_MANIFEST")
    await context.refreshAccess()
    const snapshots: string[] = []
    let outcome: "success" | "partial" | "failed" = "success"
    for (const ref of refs) {
    await context.refreshAccess()
    const version = await deps.repository.versionById(job.projectId, ref.materialVersionId)
    if (!version || version.sha256 !== ref.sha256) throw new Error("INVALID_SOURCE")
    const material = await deps.repository.findMaterial(job.projectId, version.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized) throw new Error("INVALID_SOURCE")
    await context.refreshAccess()
    const checkRetention = async () => {
      const current = await deps.repository.findMaterial(job.projectId, material.id)
      const projectUntil = await deps.readProjectRetention(job.projectId)
      const now = (deps.now?.() ?? new Date()).getTime()
      if (!current || current.status !== "active" || !projectUntil || [current.retentionUntil, projectUntil].some(day => {
        const end = Date.parse(`${day}T00:00:00Z`) + 86400000
        return !Number.isFinite(end) || now >= end
      })) throw Object.assign(new Error("Material retention expired"), { code: "RETENTION_EXPIRED" })
    }
    await checkRetention()
    const object = await deps.store.get(version.objectKey)
    if (!object || object.bytes.length !== version.size || createHash("sha256").update(object.bytes).digest("hex") !== ref.sha256) throw new Error("INVALID_SOURCE")
    await context.refreshAccess()
    const parsed = await (deps.parse ?? parseInSubprocess)({ bytes: object.bytes, format: material.format }, { signal: context.signal })
    await context.refreshAccess()
    context.signal.throwIfAborted()
    await checkRetention()
    const id = randomUUID()
    await deps.repository.addSnapshot({ id, projectId: job.projectId, materialId: material.id, versionId: version.id, revision: material.latestRevision + 1, parser: parsed.parser, parserVersion: parsed.parserVersion, coverage: parsed.coverage, createdAt: new Date().toISOString() }, parsed.fragments.map(fragment => ({ ...fragment, id: randomUUID(), projectId: job.projectId, snapshotId: id })), material.latestRevision, job)
    snapshots.push(id)
    if (parsed.coverage.status === "failed") outcome = "failed"
    else if (parsed.coverage.status === "partial" && outcome !== "failed") outcome = "partial"
    }
    return { outcome, resultSummary: JSON.stringify(snapshots) }
  }
}


