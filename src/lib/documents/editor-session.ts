import { DocumentSessionError, RevisionConflict, type createDocument, type saveDocument } from "./client"
import { documentTitle, errorMessage, type OpenDocument } from "./types"

export type EditorIntent = "save" | "export" | "copy" | "reload"
export type EditorPhase = "idle" | "checking" | "serializing" | "saving" | "exporting"
export type EngineState = "loading" | "ready" | "failed"
export type EditorSnapshot = {
  saved: OpenDocument
  title: string
  prompt: string
  dirty: boolean
  phase: EditorPhase
  engine: EngineState
  conflict: boolean
  error: string | null
}
export type EditorDependencies = {
  opened: OpenDocument
  serialize: () => Promise<Blob>
  preflight: (options: { signal: AbortSignal; copy: boolean }) => Promise<void>
  save: typeof saveDocument
  copy: typeof createDocument
  download: (blob: Blob, title: string) => void
  onSaved: (saved: OpenDocument) => void
  onSessionUnavailable: (error: DocumentSessionError) => void
}

export function createEditorSession(deps: EditorDependencies) {
  let snapshot: EditorSnapshot = {
    saved: deps.opened, title: deps.opened.document.title, prompt: deps.opened.document.prompt,
    dirty: false, phase: "idle", engine: "loading", conflict: false, error: null,
  }
  const listeners = new Set<() => void>()
  let active = false
  let unavailable = false
  let generation = 0
  let request: AbortController | null = null
  let retry: Parameters<typeof saveDocument>[0] | null = null
  const publish = (value: Partial<EditorSnapshot>) => {
    snapshot = { ...snapshot, ...value }
    for (const listener of listeners) listener()
  }
  const canEdit = () => active && !unavailable && !request

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    editTitle(value: string) {
      if (canEdit() && value !== snapshot.title) { retry = null; publish({ title: value, dirty: true }) }
    },
    editPrompt(value: string) {
      if (canEdit() && value !== snapshot.prompt) { retry = null; publish({ prompt: value, dirty: true }) }
    },
    markBodyChanged() { if (canEdit()) { retry = null; publish({ dirty: true }) } },
    setEngine(state: EngineState, message?: string) {
      if (active) publish({ engine: state, error: state === "failed" ? message ?? "文档加载失败，请重试。" : null })
    },
    async run(intent: EditorIntent): Promise<OpenDocument | null> {
      if (!active || unavailable || request || (intent !== "reload" && snapshot.engine !== "ready")
        || (snapshot.conflict && (intent === "save" || intent === "export"))) return null
      if (intent === "save" && !snapshot.dirty) return snapshot.saved
      const controller = new AbortController()
      const captured = generation
      request = controller
      const current = () => active && captured === generation && request === controller && !controller.signal.aborted
      const selected = snapshot
      try {
        publish({ phase: "checking", error: null })
        if (!current()) return null
        await deps.preflight({ signal: controller.signal, copy: intent === "copy" })
        if (!current()) return null
        if (intent === "reload") {
          retry = null
          publish({ title: selected.saved.document.title, prompt: selected.saved.document.prompt, dirty: false, engine: "loading" })
          return current() ? selected.saved : null
        }
        let result = selected.saved
        if (selected.dirty || intent === "copy") {
          let input = intent === "copy" ? null : retry
          if (!input) {
            publish({ phase: "serializing" })
            if (!current()) return null
            const blob = await deps.serialize()
            if (!current()) return null
            input = { documentId: selected.saved.document.id, baseRevision: selected.saved.revision.id,
              operationId: crypto.randomUUID(), title: documentTitle(selected.title), prompt: selected.prompt, blob }
            // A lost response may follow a committed transaction. Preserve the
            // exact bytes and operation ID until the user edits or save succeeds.
            if (intent !== "copy") retry = input
          }
          publish({ phase: "saving" })
          if (!current()) return null
          result = intent === "copy"
            ? await deps.copy(input.blob, `${documentTitle(selected.title)} 副本`, "copy", undefined, selected.prompt,
              { documentId: selected.saved.document.id, revisionId: selected.saved.revision.id }, { signal: controller.signal })
            : await deps.save(input, { signal: controller.signal })
          if (!current()) return null
          retry = null
          publish({ saved: result, title: result.document.title, prompt: result.document.prompt, dirty: false, conflict: false })
          if (!current()) return null
          deps.onSaved(result)
          if (!current()) return null
        }
        if (intent === "export") {
          publish({ phase: "exporting" })
          if (!current()) return null
          deps.download(result.revision.blob, result.document.title)
        }
        return current() ? result : null
      } catch (failure) {
        if (current()) {
          // Creation/consent errors can leave existing documents readable and
          // savable. Only lost context or editor access invalidates the session.
          const sessionLost = failure instanceof DocumentSessionError && (
            failure.code === "RETENTION_EXPIRED" || failure.code === "SESSION_CHANGED"
            || failure.code === "SESSION_CONTEXT_REQUIRED" || failure.code === "RETENTION_READ_ONLY"
            || failure.code === "LEGACY_RETENTION_PENDING"
            || failure.session?.canRead === false || failure.session?.canSave === false
          )
          if (sessionLost) { unavailable = true; retry = null }
          publish({ error: errorMessage(failure), conflict: snapshot.conflict || failure instanceof RevisionConflict })
          if (current() && sessionLost) deps.onSessionUnavailable(failure)
        }
        return null
      } finally {
        if (request === controller) {
          request = null
          publish({ phase: "idle" })
        }
      }
    },
    activate() { active = true },
    dispose() {
      active = false
      generation++
      request?.abort()
      request = null
      publish({ phase: "idle" })
    },
  }
}
