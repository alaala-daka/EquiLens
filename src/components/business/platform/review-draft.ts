import { defaultReviewScene, isReviewScene, type ReviewDraft, type ReviewMaterialSelection } from "./review-state"

/**
 * Project-scoped preparation input for the review conditions (B2a).
 *
 * Round three freezes the existing HTTP surface, so the task conditions cannot
 * be saved on the server. They are kept as a browser-local preparation draft
 * keyed by project, written only when the user saves and leaves, and never
 * submitted or sent to a model by saving. Nothing here promises recovery after
 * a hard refresh; the workspace only restores a deliberately saved draft.
 */
export type ReviewDraftStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function reviewDraftStorageKey(projectId: string): string {
  return `equilens.review-draft.${projectId}`
}

export function serializeReviewDraft(draft: ReviewDraft): string {
  return JSON.stringify(draft)
}

function selection(value: unknown): ReviewMaterialSelection | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ReviewMaterialSelection>
  if (typeof candidate.id !== "string" || !candidate.id) return null
  if (typeof candidate.versionId !== "string" || !candidate.versionId) return null
  if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) return null
  return { id: candidate.id, versionId: candidate.versionId, sha256: candidate.sha256 }
}

/** Corrupt, foreign or oversized drafts are ignored instead of breaking the form. */
export function parseReviewDraft(raw: string | null): ReviewDraft | null {
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<ReviewDraft> & Record<string, unknown>
  if (candidate.version !== 1) return null
  const materials = Array.isArray(candidate.materials)
    ? candidate.materials.flatMap(item => {
      const parsed = selection(item)
      return parsed ? [parsed] : []
    }).slice(0, 10)
    : []
  return {
    version: 1,
    materials,
    scene: isReviewScene(candidate.scene) ? candidate.scene : defaultReviewScene,
    region: typeof candidate.region === "string" ? candidate.region.slice(0, 100) : "",
  }
}

export function readReviewDraft(storage: ReviewDraftStorage | null, projectId: string): ReviewDraft | null {
  if (!storage) return null
  try { return parseReviewDraft(storage.getItem(reviewDraftStorageKey(projectId))) } catch { return null }
}

/** Resolves true only when the draft was actually persisted. */
export function writeReviewDraft(storage: ReviewDraftStorage | null, projectId: string, draft: ReviewDraft): boolean {
  if (!storage) return false
  storage.setItem(reviewDraftStorageKey(projectId), serializeReviewDraft(draft))
  return true
}

export function clearReviewDraft(storage: ReviewDraftStorage | null, projectId: string): void {
  if (!storage) return
  try { storage.removeItem(reviewDraftStorageKey(projectId)) } catch { /* dropping a draft must not trap navigation */ }
}

/** Per-tab browser storage; a blocked storage simply means the draft cannot be saved. */
export function browserReviewDraftStorage(): ReviewDraftStorage | null {
  if (typeof window === "undefined") return null
  try { return window.sessionStorage } catch { return null }
}
