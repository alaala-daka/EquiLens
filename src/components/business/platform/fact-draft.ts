import type { ProjectFactDraft, ProjectFactVersion } from "@/lib/facts/types"
import type { FactCandidate, FactCandidatesValue } from "@/lib/business/facts-client"

export function emptyFactDraft(): ProjectFactDraft {
  return { field: "", nature: "人工陈述", sources: [], conflicts: [], confirmation: "未确认", support: "仅人工陈述" }
}
export function savedFactDraft(fact: ProjectFactVersion): ProjectFactDraft {
  const { projectId: _project, factId: _fact, factVersionId: _version, version: _number, supersedesVersionId: _prior, sha256: _sha, createdAt: _at, createdBy: _by, evidenceStatus: _evidence, ...value } = fact
  void _project; void _fact; void _version; void _number; void _prior; void _sha; void _at; void _by; void _evidence
  return value
}
export function candidateFactDraft(projectId: string, candidate: FactCandidate, result: FactCandidatesValue): ProjectFactDraft {
  const { candidateId: _id, sources, ...value } = candidate
  void _id
  return { ...value, ...(candidate.originalValue ? { selectedValue: candidate.originalValue } : {}), confirmation: "未确认", support: "材料支持", conflicts: [],
    sources: sources.map(source => {
      const material = result.materials.find(item => item.snapshotId === source.snapshotId)!
      return { projectId, materialId: material.materialId, materialVersionId: material.materialVersionId, parseSnapshotId: source.snapshotId, fragmentId: source.fragmentId, quote: source.quote, ...(source.locator ? { locator: source.locator } : {}) }
    }) }
}
