import type { DocumentRecord } from "./types"

export type DocumentListSnapshot =
  | { kind: "loading"; documents: readonly DocumentRecord[]; error: null; refreshing: false }
  | { kind: "initial-error"; documents: readonly DocumentRecord[]; error: string; refreshing: false }
  | { kind: "ready"; documents: readonly DocumentRecord[]; error: string | null; refreshing: boolean }

export type DocumentListStore = {
  getSnapshot(): DocumentListSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  upsert(document: DocumentRecord): void
  cancel(): void
  reset(): void
}

export function createDocumentListStore(
  fetchDocuments: (signal: AbortSignal) => Promise<DocumentRecord[]>,
): DocumentListStore {
  let snapshot: DocumentListSnapshot = { kind: "loading", documents: [], error: null, refreshing: false }
  let generation = 0
  let controller: AbortController | null = null
  const listeners = new Set<() => void>()
  const publish = (value: DocumentListSnapshot) => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  const cancelPending = () => {
    generation += 1
    controller?.abort()
    controller = null
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh() {
      cancelPending()
      const captured = generation
      const pending = new AbortController()
      controller = pending
      publish(snapshot.kind === "ready" ? { ...snapshot, error: null, refreshing: true }
        : { kind: "loading", documents: [], error: null, refreshing: false })
      try {
        const documents = await fetchDocuments(pending.signal)
        if (captured !== generation || pending.signal.aborted) return
        publish({ kind: "ready", documents, error: null, refreshing: false })
      } catch (failure) {
        if (captured !== generation || pending.signal.aborted) return
        const error = failure instanceof Error ? failure.message : "读取文档失败，请重试。"
        publish(snapshot.kind === "ready" ? { ...snapshot, error, refreshing: false }
          : { kind: "initial-error", documents: [], error, refreshing: false })
      } finally {
        if (controller === pending) controller = null
      }
    },
    upsert(document) {
      cancelPending()
      if (snapshot.kind !== "ready") return
      publish({ kind: "ready", documents: [document, ...snapshot.documents.filter(row => row.id !== document.id)], error: null, refreshing: false })
    },
    cancel() {
      cancelPending()
      if (snapshot.kind === "ready") publish({ ...snapshot, refreshing: false })
    },
    reset() {
      cancelPending()
      publish({ kind: "loading", documents: [], error: null, refreshing: false })
    },
  }
}
