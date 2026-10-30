import assert from "node:assert/strict"
import { test } from "node:test"
import { candidateFactDraft, savedFactDraft } from "./fact-draft"

test("candidate confirmation pins immutable materials without inheriting machine confirmation", () => {
  const candidate = { candidateId: "candidate", field: "价款", nature: "拟约定" as const, originalValue: "100万", sources: [{ snapshotId: "snapshot", fragmentId: "fragment", quote: "合同暂定100万" }] }
  const value = { schemaVersion: 1 as const, complete: true, materials: [{ materialId: "material", materialVersionId: "version", snapshotId: "snapshot", sha256: "a".repeat(64), title: "合同" }], candidates: [candidate], rejected: [], warnings: [] }
  const draft = candidateFactDraft("project", candidate, value)
  assert.equal(draft.confirmation, "未确认")
  assert.equal(draft.nature, "拟约定")
  assert.equal(draft.sources[0].materialVersionId, "version")
  const saved = { ...draft, projectId: "project", factId: "fact", factVersionId: "fv1", version: 1, createdBy: "member", createdAt: "today", sha256: "digest", evidenceStatus: "材料支持" as const }
  assert.deepEqual(savedFactDraft(saved), draft)
  assert.equal("candidateId" in draft, false)
  assert.equal("createdBy" in savedFactDraft(saved), false)
})
