import type { DocumentListStore } from "./list-store"
import type { OpenDocument } from "./types"

export type DocumentOperation = "creating" | "importing" | "opening"
export type OperationSnapshot = { operation: DocumentOperation | null; error: Error | null }

export type OperationDependencies = {
  list: DocumentListStore
  blank: () => Blob
  validate: (blob: Blob, signal: AbortSignal) => Promise<unknown>
  create: (blob: Blob, title: string, source: "authored" | "imported", fileName: string | undefined,
    signal: AbortSignal) => Promise<OpenDocument | null>
  open: (id: string, signal: AbortSignal) => Promise<OpenDocument>
  onOpened: (opened: OpenDocument) => void
}

export function createDocumentOperations(deps: OperationDependencies) {
  let active: { controller: AbortController } | null = null
  let snapshot: OperationSnapshot = { operation: null, error: null }
  const listeners = new Set<() => void>()
  const publish = (value: OperationSnapshot) => {
    snapshot = value
    for (const listener of listeners) listener()
  }

  async function run(kind: DocumentOperation, work: (signal: AbortSignal) => Promise<OpenDocument | null>) {
    if (active) return
    const current = { controller: new AbortController() }
    active = current
    deps.list.cancel()
    publish({ operation: kind, error: null })
    try {
      const opened = await work(current.controller.signal)
      if (active !== current || current.controller.signal.aborted || !opened) return
      if (kind !== "opening") deps.list.upsert(opened.document)
      deps.onOpened(opened)
    } catch (failure) {
      if (active === current && !current.controller.signal.aborted) {
        publish({ operation: kind, error: failure instanceof Error ? failure : new Error("文档操作失败，请重试。") })
      }
    } finally {
      if (active === current) { active = null; publish({ operation: null, error: snapshot.error }) }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    create(file?: File) {
      return run(file ? "importing" : "creating", async signal => {
        if (file && !/\.docx$/i.test(file.name)) throw new Error("请选择 .docx 格式的 Word 文档。")
        const blob = file ?? deps.blank()
        await deps.validate(blob, signal)
        signal.throwIfAborted()
        return deps.create(blob, file ? file.name.replace(/\.docx$/i, "") : "未命名文档",
          file ? "imported" : "authored", file?.name, signal)
      })
    },
    open(id: string) {
      return run("opening", async signal => {
        const opened = await deps.open(id, signal)
        signal.throwIfAborted()
        await deps.validate(opened.revision.blob, signal)
        signal.throwIfAborted()
        return opened
      })
    },
    cancel() {
      const prior = active
      active = null
      prior?.controller.abort()
      publish({ operation: null, error: null })
    },
  }
}
