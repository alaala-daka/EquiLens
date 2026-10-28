import { errorMessage } from "./types"

/**
 * Workspace-level unsaved object registry (A2).
 *
 * The editor controller protects the document itself. 乙/丙 also hold unsaved
 * facts, payments, evidence, results and task conditions inside the same
 * workspace; those must be registered here so the workbench can save and leave
 * only when every object succeeded. Entries are removed as soon as they save,
 * so retrying after a partial failure never creates a second saved version of
 * an object that already committed.
 */
export type UnsavedEntry = {
  /** Stable identifier, e.g. "fact:<versionId>"; re-registering replaces the entry. */
  id: string
  /** Short product copy for the pending-change notice. */
  label: string
  /** Persist pending edits; resolve true only after the server confirmed the saved version. */
  save: () => Promise<boolean>
  /** Drop in-memory edits after the user explicitly chose to discard. */
  discard?: () => void
}

export type UnsavedFailure = { id: string; label: string; message: string }

export type UnsavedSnapshot = {
  entries: readonly { id: string; label: string }[]
  failures: readonly UnsavedFailure[]
  saving: boolean
}

export type UnsavedSaveResult = {
  /** True only when nothing failed and no new unsaved object appeared during saving. */
  ok: boolean
  failures: readonly UnsavedFailure[]
}

export type UnsavedRegistry = {
  register(entry: UnsavedEntry): () => void
  getSnapshot(): UnsavedSnapshot
  subscribe(listener: () => void): () => void
  hasUnsaved(): boolean
  /** Save every pending entry once (single flight). Already-saved entries are dropped. */
  saveAll(): Promise<UnsavedSaveResult>
  discardAll(): void
}

export function createUnsavedRegistry(): UnsavedRegistry {
  const entries = new Map<string, UnsavedEntry>()
  const listeners = new Set<() => void>()
  let saving = false
  let failures: readonly UnsavedFailure[] = []
  let snapshot: UnsavedSnapshot = { entries: [], failures, saving }
  let inFlight: Promise<UnsavedSaveResult> | null = null

  const publish = () => {
    snapshot = {
      entries: [...entries.values()].map(entry => ({ id: entry.id, label: entry.label })),
      failures,
      saving,
    }
    for (const listener of listeners) listener()
  }

  const saveAll = (): Promise<UnsavedSaveResult> => {
    if (inFlight) return inFlight
    const work = async (): Promise<UnsavedSaveResult> => {
      saving = true
      failures = []
      publish()
      const failed: UnsavedFailure[] = []
      // Snapshot the entries so an entry registered during saving is reported
      // as still unsaved instead of being silently saved in this pass.
      for (const entry of [...entries.values()]) {
        if (entries.get(entry.id) !== entry) continue
        try {
          const saved = await entry.save()
          if (saved) {
            // The entry may have been replaced while saving; never drop a newer edit.
            if (entries.get(entry.id) === entry) entries.delete(entry.id)
          } else {
            failed.push({ id: entry.id, label: entry.label, message: "未确认保存成功，请重试。" })
          }
        } catch (failure) {
          failed.push({ id: entry.id, label: entry.label, message: errorMessage(failure) })
        }
      }
      failures = failed
      saving = false
      publish()
      return { ok: failed.length === 0 && entries.size === 0, failures: failed }
    }
    inFlight = work().finally(() => { inFlight = null })
    return inFlight
  }

  return {
    register(entry) {
      entries.set(entry.id, entry)
      failures = failures.filter(failure => failure.id !== entry.id)
      publish()
      return () => {
        // A stale unregister from an earlier registration must not remove the
        // replacement the component registered for its newer edit.
        if (entries.get(entry.id) !== entry) return
        entries.delete(entry.id)
        failures = failures.filter(failure => failure.id !== entry.id)
        publish()
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    hasUnsaved: () => entries.size > 0,
    saveAll,
    discardAll() {
      if (saving) return
      const pending = [...entries.values()]
      entries.clear()
      failures = []
      publish()
      for (const entry of pending) {
        try { entry.discard?.() } catch { /* dropping in-memory edits must not trap navigation */ }
      }
    },
  }
}
