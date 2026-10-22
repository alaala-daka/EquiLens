"use client"

import { useEffect, useImperativeHandle, useRef } from "react"
import type { SuperDoc } from "superdoc"
import "superdoc/style.css"
import { editorText, serializeWord } from "@/lib/documents/serialize"
import { validateDocx } from "@/lib/documents/validate"

export type WordCanvasHandle = { serialize: () => Promise<Blob> }

export function WordCanvas({ initialBlob, onReady, onChange, onError, ref }: {
  initialBlob: Blob
  onReady: () => void
  onChange: () => void
  onError: (message: string) => void
  ref: React.Ref<WordCanvasHandle>
}) {
  const container = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const engine = useRef<SuperDoc | null>(null)
  const ready = useRef(false)
  const errors = useRef(0)

  useImperativeHandle(ref, () => ({
    async serialize() {
      const instance = engine.current
      if (!instance || !ready.current) throw new Error("文档尚未就绪。")
      const editor = instance.activeEditor
      if (!editor) throw new Error("文档尚未就绪。")
      const snapshot = structuredClone(editor.getJSON())
      const text = editorText(snapshot)
      const editable = editor.isEditable
      editor.setEditable(false, false)
      try {
        const blob = await serializeWord(() => instance.export({ exportType: ["docx"], triggerDownload: false }), () => errors.current)
        if (editorText(editor.getJSON()) !== text) throw new Error("导出过程改变了编辑内容，此次结果未保存，请重试。")
        await validateDocx(blob, undefined, false, text)
        return blob
      } catch (failure) {
        if (editorText(editor.getJSON()) !== text) {
          const restored = editor.schema.nodeFromJSON(snapshot)
          editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, restored.content).setMeta("addToHistory", false))
        }
        throw failure
      } finally { editor.setEditable(editable, false) }
    },
  }), [])

  useEffect(() => {
    let disposed = false
    let instance: SuperDoc | undefined
    let contentFailed = false
    const controller = new AbortController()
    const host = container.current!
    const tools = toolbar.current!
    const id = `word-toolbar-${crypto.randomUUID()}`
    tools.id = id
    ready.current = false
    const timeout = setTimeout(() => {
      if (disposed || ready.current) return
      disposed = true
      engine.current = null
      instance?.destroy()
      onError("文档加载超时，请返回列表后重试。")
    }, 60000)
    void Promise.all([import("superdoc"), validateDocx(initialBlob, controller.signal, true)]).then(([{ SuperDoc: Editor }, workingBlob]) => {
      if (disposed) return
      instance = new Editor({
        selector: host,
        toolbar: `#${id}`,
        document: new File([workingBlob], "document.docx", { type: workingBlob.type }),
        documentMode: "editing",
        role: "editor",
        telemetry: { enabled: false },
        proofing: { enabled: false },
        zoom: { mode: "fit-width" },
        uiDisplayFallbackFont: 'Arial, "Microsoft YaHei", sans-serif',
        modules: {
          comments: false,
          contextMenu: { includeDefaultItems: false },
          toolbar: {
            hideButtons: false,
            responsiveToContainer: true,
            groups: {
              left: ["undo", "redo", "fontFamily", "fontSize", "bold", "italic", "underline", "color", "highlight", "linkedStyles", "textAlign", "list", "numberedlist"],
              right: ["zoom"],
            },
          },
        },
        onReady: () => {
          if (disposed || contentFailed) return
          clearTimeout(timeout)
          ready.current = true
          onReady()
        },
        onEditorUpdate: () => { if (!disposed && ready.current) onChange() },
        onContentError: () => {
          if (disposed) return
          contentFailed = true
          ready.current = false
          clearTimeout(timeout)
          errors.current++
          onError("无法打开此 Word 文档，请检查文件内容。")
        },
        onException: () => { if (!disposed) { errors.current++; onError("文档编辑发生错误，请保留当前内容并重试。") } },
      })
      engine.current = instance
    }).catch(() => { if (!disposed) { clearTimeout(timeout); onError("Word 编辑器加载失败，请重试。") } })
    return () => {
      disposed = true
      controller.abort()
      ready.current = false
      clearTimeout(timeout)
      engine.current = null
      instance?.destroy()
      host.replaceChildren()
      tools.replaceChildren()
    }
  }, [initialBlob, onReady, onChange, onError])

  return <div className="word-canvas flex h-full min-h-0 flex-col">
    <div ref={toolbar} className="shrink-0 overflow-x-auto border-b bg-background" />
    <div className="min-h-0 flex-1 overflow-auto bg-muted" aria-label="Word 正文">
      <div ref={container} />
    </div>
  </div>
}
