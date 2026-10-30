import { z } from "zod"
import type { ResultValidator } from "../results/validation"

const text = (max = 500) => z.string().trim().min(1).max(max)
export const candidateSourceSchema = z.object({ snapshotId: text(128), fragmentId: text(128), quote: text(10000), locator: text().optional() }).strict()
export const factCandidateSchema = z.object({
  candidateId: text(128), field: text(), subject: text().optional(), nature: z.enum(["材料记载", "人工陈述", "拟约定"]),
  originalValue: text().optional(), candidates: z.array(text()).max(100).optional(), unit: text().optional(), caliber: text().optional(),
  occurredAt: z.iso.date().optional(), periodStart: z.iso.date().optional(), periodEnd: z.iso.date().optional(), sources: z.array(candidateSourceSchema).min(1).max(100),
}).strict()
export const factCandidatesSchema = z.object({
  schemaVersion: z.literal(1), cutoff: z.iso.date().optional(),
  materials: z.array(z.object({ materialId: text(128), materialVersionId: text(128), snapshotId: text(128), sha256: z.string().regex(/^[a-f0-9]{64}$/), title: text() }).strict()).min(1).max(5),
  complete: z.boolean(), candidates: z.array(factCandidateSchema).min(1).max(100),
  rejected: z.array(z.object({ quote: text(10000).optional(), reason: text(), detail: text().optional() }).strict()).max(100), warnings: z.array(text(2000)).max(100),
}).strict()
export type FactCandidatesValue = z.infer<typeof factCandidatesSchema>
export type FactCandidate = FactCandidatesValue["candidates"][number]

export const factCandidatesValidator: ResultValidator = async value => {
  const parsed = factCandidatesSchema.safeParse(value)
  if (!parsed.success) return { status: "invalid", issues: [{ code: "FACT_CANDIDATES_INVALID", message: "事实候选结构无效。" }] }
  const facts = parsed.data
  const snapshots = new Set(facts.materials.map(material => material.snapshotId))
  const ids = new Set(facts.candidates.map(candidate => candidate.candidateId))
  const materialIds = new Set(facts.materials.map(material => material.materialVersionId))
  if (ids.size !== facts.candidates.length || snapshots.size !== facts.materials.length || materialIds.size !== facts.materials.length ||
    facts.candidates.some(candidate => candidate.sources.some(source => !snapshots.has(source.snapshotId)) ||
      (candidate.periodStart && candidate.periodEnd && candidate.periodStart > candidate.periodEnd))) {
    return { status: "invalid", issues: [{ code: "FACT_CANDIDATES_SOURCE", message: "事实候选与材料清单不一致。" }] }
  }
  return { status: !facts.complete || facts.rejected.length || facts.warnings.length ? "partial" : "valid", issues: [] }
}
