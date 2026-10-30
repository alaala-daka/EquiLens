import assert from "node:assert/strict"
import test from "node:test"
import {
  browserVerificationDraftStorage, clearVerificationDraft, defaultVerificationFormDraft, isVerificationDraftDirty,
  parseVerificationDraft, readVerificationDraft, serializeVerificationDraft, verificationDraftKey,
  writeVerificationDraft, type VerificationDraftStorage,
} from "./verification-draft"

function storage(initial: Record<string, string> = {}): VerificationDraftStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

const draft = {
  ...defaultVerificationFormDraft(),
  extraction: { materialIds: ["material-1"], asOf: "2026-10-29", consent: true },
  comparison: { materialIds: ["material-2"], requirementSetResultId: "set-1", asOf: "2026-10-30", recordIds: ["record-1"] },
  field: { fieldKey: "certificate_number" as const, valueText: "123", subjectKey: "enterprise", sourceFragmentId: "fragment-1", reason: "更正" },
  externalRecord: { requirementId: "REQ-1", subject: "投标人", certificateNo: "C1", source: "平台", queriedAt: "2026-10-29T10:00", queryConditions: "条件", conclusion: "matched" as const, proofMaterialVersionId: "version-1" },
  fieldMaterialId: "material-2",
}

test("C4-UI: verification draft key is project-scoped", () => {
  assert.equal(verificationDraftKey("project-1"), "equilens.verification-draft.project-1")
  assert.notEqual(verificationDraftKey("project-1"), verificationDraftKey("project-2"))
})

test("C4-UI: a saved verification draft round-trips per project", () => {
  assert.deepEqual(parseVerificationDraft(serializeVerificationDraft(draft)), draft)
  const store = storage({ "equilens.verification-draft.other": "keep" })
  assert.equal(writeVerificationDraft(store, "project-1", draft), true)
  assert.deepEqual(readVerificationDraft(store, "project-1"), draft)
  assert.equal(readVerificationDraft(store, "project-2"), null)
  clearVerificationDraft(store, "project-1")
  assert.equal(readVerificationDraft(store, "project-1"), null)
  assert.equal(store.values.get("equilens.verification-draft.other"), "keep")
  assert.equal(readVerificationDraft(null, "project-1"), null)
  assert.equal(writeVerificationDraft(null, "project-1", draft), false)
})

test("C4-UI: corrupt, foreign or oversized drafts are ignored", () => {
  assert.equal(parseVerificationDraft(null), null)
  assert.equal(parseVerificationDraft("not-json"), null)
  assert.equal(parseVerificationDraft("[]"), null)
  assert.equal(parseVerificationDraft(JSON.stringify({ version: 2 })), null)
  const sanitised = parseVerificationDraft(JSON.stringify({
    version: 1,
    extraction: { materialIds: ["a", 2, "a".repeat(200)], asOf: "x".repeat(20), consent: "yes" },
    comparison: { materialIds: ["b"], requirementSetResultId: 5, asOf: "2026-10-29", recordIds: ["r", 7] },
    field: { fieldKey: "not_a_field", valueText: "v", subjectKey: "", sourceFragmentId: 1, reason: "r" },
    externalRecord: { requirementId: "R1", conclusion: "unknown" },
    fieldMaterialId: "m",
  }))
  assert.deepEqual(sanitised?.extraction, { materialIds: ["a"], asOf: "", consent: false })
  assert.deepEqual(sanitised?.comparison, { materialIds: ["b"], requirementSetResultId: "", asOf: "2026-10-29", recordIds: ["r"] })
  assert.equal(sanitised?.field.fieldKey, "subject_name")
  assert.equal(sanitised?.field.subjectKey, "enterprise")
  assert.equal(sanitised?.externalRecord.conclusion, "")
  assert.equal(sanitised?.fieldMaterialId, "m")
})

test("C4-UI: blocked storage degrades to no draft, never throws on read/clear", () => {
  const broken: VerificationDraftStorage = {
    getItem: () => { throw new Error("blocked") },
    setItem: () => { throw new Error("quota") },
    removeItem: () => { throw new Error("blocked") },
  }
  assert.equal(readVerificationDraft(broken, "project-1"), null)
  assert.throws(() => writeVerificationDraft(broken, "project-1", draft), /quota/)
  assert.doesNotThrow(() => clearVerificationDraft(broken, "project-1"))
  assert.equal(browserVerificationDraftStorage(), null, "the Node test runtime has no browser storage")
})

test("C4-UI: only real preparation input counts as a dirty verification draft", () => {
  assert.equal(isVerificationDraftDirty(defaultVerificationFormDraft()), false)
  assert.equal(isVerificationDraftDirty(draft), true)
  for (const patch of [
    { extraction: { materialIds: ["m"], asOf: "", consent: false } },
    { extraction: { materialIds: [], asOf: "", consent: true } },
    { comparison: { materialIds: [], requirementSetResultId: "set-1", asOf: "", recordIds: [] } },
    { field: { ...defaultVerificationFormDraft().field, valueText: "x" } },
    { externalRecord: { ...defaultVerificationFormDraft().externalRecord, source: "平台" } },
    { fieldMaterialId: "material-1" },
  ]) {
    assert.equal(isVerificationDraftDirty({ ...defaultVerificationFormDraft(), ...patch }), true)
  }
})
