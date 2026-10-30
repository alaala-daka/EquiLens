import assert from "node:assert/strict"
import test from "node:test"
import {
  browserReviewDraftStorage,
  clearReviewDraft,
  parseReviewDraft,
  readReviewDraft,
  reviewDraftStorageKey,
  serializeReviewDraft,
  writeReviewDraft,
  type ReviewDraftStorage,
} from "./review-draft"
import { defaultReviewDraft, defaultReviewScene, type ReviewDraft } from "./review-state"

function storage(initial: Record<string, string> = {}): ReviewDraftStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

const draft: ReviewDraft = {
  version: 1,
  materials: [{ id: "material-1", versionId: "version-1", sha256: "a".repeat(64) }],
  scene: "decoration-sub-2026",
  region: "上海市",
}

test("B2a: draft storage key is project-scoped", () => {
  assert.equal(reviewDraftStorageKey("project-1"), "equilens.review-draft.project-1")
  assert.notEqual(reviewDraftStorageKey("project-1"), reviewDraftStorageKey("project-2"))
})

test("B2a: a saved draft round-trips and is restored only when it is valid", () => {
  assert.deepEqual(parseReviewDraft(serializeReviewDraft(draft)), draft)
  assert.deepEqual(parseReviewDraft(JSON.stringify({ ...draft, scene: "auto", region: "x".repeat(200) })), {
    version: 1,
    materials: draft.materials,
    scene: defaultReviewScene,
    region: "x".repeat(100),
  })
  assert.equal(parseReviewDraft(null), null)
  assert.equal(parseReviewDraft("not-json"), null)
  assert.equal(parseReviewDraft("[]"), null)
  assert.equal(parseReviewDraft(JSON.stringify({ version: 2 })), null)
  const sanitised = parseReviewDraft(JSON.stringify({
    version: 1,
    materials: [
      { id: "a", versionId: "v", sha256: "not-a-digest" },
      { id: "b", versionId: "v", sha256: "c".repeat(64) },
      { id: "", versionId: "v", sha256: "c".repeat(64) },
      "garbage",
    ],
    scene: "mep-sub-2026",
    region: "上海",
  }))
  assert.deepEqual(sanitised?.materials, [{ id: "b", versionId: "v", sha256: "c".repeat(64) }])
})

test("B2a: saving and clearing a draft only touches the project's own key", () => {
  const store = storage({ "equilens.review-draft.other": "keep" })
  assert.equal(writeReviewDraft(store, "project-1", draft), true)
  assert.ok(store.values.has("equilens.review-draft.project-1"))
  assert.deepEqual(readReviewDraft(store, "project-1"), draft)
  assert.equal(readReviewDraft(store, "project-2"), null)
  clearReviewDraft(store, "project-1")
  assert.equal(readReviewDraft(store, "project-1"), null)
  assert.equal(store.values.get("equilens.review-draft.other"), "keep")
  assert.equal(readReviewDraft(null, "project-1"), null)
  assert.equal(writeReviewDraft(null, "project-1", draft), false)
})

test("B2a: a blocked or corrupt storage degrades to no draft, never throws", () => {
  const broken: ReviewDraftStorage = {
    getItem: () => { throw new Error("blocked") },
    setItem: () => { throw new Error("quota") },
    removeItem: () => { throw new Error("blocked") },
  }
  assert.equal(readReviewDraft(broken, "project-1"), null)
  assert.throws(() => writeReviewDraft(broken, "project-1", draft), /quota/)
  assert.doesNotThrow(() => clearReviewDraft(broken, "project-1"))
  assert.equal(browserReviewDraftStorage(), null, "the Node test runtime has no browser storage")
  assert.deepEqual(defaultReviewDraft(), { version: 1, materials: [], scene: "mep-sub-2026", region: "" })
})
