"use client"

import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react"
import type { SuperDoc } from "superdoc"
import "superdoc/style.css"
import { Button } from "@/components/ui/button"
import { createEngineLoad } from "@/lib/documents/engine-lifecycle"
import type { EngineState } from "@/lib/documents/editor-session"
import { createWordSerializer, editorStructures, editorText, WordExportTimeout } from "@/lib/documents/serialize"
import type { ExportExpectation } from "@/lib/documents/structures"
import { editorFocusShortcut } from "@/lib/documents/editor-keyboard"
import { validateDocx } from "@/lib/documents/validate"

export type WordCanvasHandle = { serialize: () => Promise<Blob>; snapshot: () => unknown }

export function WordCanvas({ initialBlob, reloadToken = 0, onStateChange, onChange, keyboardHelpId, keyboardBlocked, controlsDisabled, onFocusShortcut, ref }: {
  initialBlob: Blob
  reloadToken?: number
  onStateChange: (state: EngineState, message?: string) => void
  onChange: () => void
  keyboardHelpId: string
  keyboardBlocked: boolean
  controlsDisabled: boolean
  onFocusShortcut: (destination: "agent" | "actions") => boolean
  ref: React.Ref<WordCanvasHandle>
}) {
  const container = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const engine = useRef<WordCanvasHandle | null>(null)
  const zoomEngine = useRef<SuperDoc | null>(null)
  const [fitWidth, setFitWidth] = useState(true)
  const notifyState = useEffectEvent((state: EngineState, message?: string) => {
    onStateChange(state, message)
  })
  const notifyChange = useEffectEvent(() => onChange())

  const routeFocus = useEffectEvent((event: KeyboardEvent, composing: boolean, popupOpen: boolean) => {
    const destination = editorFocusShortcut(event, { inBody: true, busy: keyboardBlocked || composing, popupOpen })
    return destination ? onFocusShortcut(destination) : false
  })

  useImperativeHandle(ref, () => ({
    async serialize() {
      if (!engine.current) throw new Error("文档尚未就绪。")
      return engine.current.serialize()
    },
    snapshot() {
      if (!engine.current) throw new Error("文档尚未就绪。")
      return engine.current.snapshot()
    },
  }), [])

  useEffect(() => {
    let disposed = false
    let instance: SuperDoc | undefined
    let destroyed: SuperDoc | undefined
    let ready = false
    let hadReady = false
    let errors = 0
    // Own child containers, so late vendor cleanup cannot clear a new mount.
    const host = document.createElement("div")
    const tools = document.createElement("div")
    container.current!.appendChild(host)
    toolbar.current!.appendChild(tools)
    const id = `word-toolbar-${crypto.randomUUID()}`
    tools.id = id
    const destroy = () => {
      if (!instance || destroyed === instance) return
      destroyed = instance
      instance.destroy()
    }
    let composing = false
    const owns = (target: EventTarget | null) => {
      const body = instance?.activeEditor?.view?.dom
      return !disposed && ready && load.isCurrent() && engine.current === session
        && target instanceof Node && !!body && (target === body || body.contains(target))
    }
    const compositionStart = (event: CompositionEvent) => { if (owns(event.target)) composing = true }
    const compositionEnd = (event: CompositionEvent) => { if (owns(event.target)) composing = false }
    const blur = (event: FocusEvent) => { if (owns(event.target)) composing = false }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || !owns(event.target)) return
      const popupOpen = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], .toolbar-dropdown-menu, .overflow-menu_items, .generic-popover'))
        .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
      if (!routeFocus(event, composing, popupOpen)) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener("keydown", keydown, true)
    document.addEventListener("compositionstart", compositionStart, true)
    document.addEventListener("compositionend", compositionEnd, true)
    document.addEventListener("blur", blur, true)
    const release = () => {
      document.removeEventListener("keydown", keydown, true)
      document.removeEventListener("compositionstart", compositionStart, true)
      document.removeEventListener("compositionend", compositionEnd, true)
      document.removeEventListener("blur", blur, true)
      disposed = true
      ready = false
      load.dispose()
      if (engine.current === session) engine.current = null
      if (zoomEngine.current === instance) zoomEngine.current = null
      try { destroy() } finally { host.remove(); tools.remove() }
    }
    const fail = (message: string) => {
      if (disposed) return
      ready = false
      errors++
      load.dispose()
      notifyState("failed", message)
    }
    const load = createEngineLoad({ timeoutMs: 60000, onTimeout: () => {
      try { release() } finally { notifyState("failed", "文档加载超时，请重新加载后重试。") }
    } })
    const serialize = createWordSerializer(() => errors)
    const session: WordCanvasHandle = {
      snapshot() {
        if (disposed || !load.isCurrent() || !ready || engine.current !== session || !instance?.activeEditor) {
          throw new Error("文档尚未就绪。")
        }
        return structuredClone(instance.activeEditor.getJSON())
      },
      async serialize() {
        if (disposed || !load.isCurrent() || !ready || engine.current !== session || !instance?.activeEditor) {
          throw new Error("文档尚未就绪。")
        }
        const currentInstance = instance
        const editor = instance.activeEditor
        const current = () => !disposed && engine.current === session
        try {
          return await serialize(async () => {
            const snapshot = structuredClone(editor.getJSON())
            const expected: ExportExpectation = { text: editorText(snapshot), structures: editorStructures(snapshot) }
            const editable = editor.isEditable
            editor.setEditable(false, false)
            try {
              const before = errors
              const blob = await currentInstance.export({ exportType: ["docx"], triggerDownload: false })
              if (!current()) throw new Error("操作已取消。")
              // The vendor can return original bytes after emitting an error.
              if (errors !== before || !blob?.size) throw new Error("Word 文档导出失败，当前编辑已保留，请重试。")
              if (!ready) throw new Error("操作已取消。")
              if (editorText(editor.getJSON()) !== expected.text) throw new Error("导出过程改变了编辑内容，此次结果未保存，请重试。")
              await validateDocx(blob, load.signal, false, expected)
              if (!current() || !ready) throw new Error("操作已取消。")
              return blob
            } catch (failure) {
              if (current() && editorText(editor.getJSON()) !== expected.text) {
                const restored = editor.schema.nodeFromJSON(snapshot)
                editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, restored.content).setMeta("addToHistory", false))
              }
              throw failure
            } finally { if (current()) editor.setEditable(editable, false) }
          })
        } catch (failure) {
          if (failure instanceof WordExportTimeout && current()) fail(failure.message)
          throw failure
        }
      },
    }
    engine.current = session
    notifyState("loading")
    void Promise.all([import("superdoc"), validateDocx(initialBlob, load.signal, true)]).then(([{ SuperDoc: Editor }, workingBlob]) => {
      if (!load.isCurrent()) return
      instance = new Editor({
        selector: host,
        toolbar: `#${id}`,
        document: new File([workingBlob], "document.docx", { type: workingBlob.type }),
        documentMode: "editing",
        role: "editor",
        telemetry: { enabled: false },
        proofing: { enabled: false },
        zoom: { initial: 100, mode: "fit-width", fitWidth: { min: 10, max: 200, padding: 64 } },
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
        onReady: ({ superdoc }) => {
          if (!load.ready()) return
          instance = superdoc
          zoomEngine.current = superdoc
          setFitWidth(superdoc.getZoomState().mode === "fit-width")
          const body = superdoc.activeEditor?.view?.dom
          body?.setAttribute("aria-describedby", keyboardHelpId)
          body?.setAttribute("aria-keyshortcuts", "F6 Shift+F6")
          ready = true
          hadReady = true
          notifyState("ready")
        },
        onZoomChange: ({ mode }) => {
          if (!disposed && load.isCurrent()) setFitWidth(mode === "fit-width")
        },
        onEditorUpdate: () => { if (!disposed && hadReady) notifyChange() },
        onContentError: () => fail("无法打开此 Word 文档，请检查文件内容。"),
        onException: () => fail("文档编辑发生错误，当前内容已保留，请重新加载后重试。"),
      })
      if (disposed) destroy()
    }).catch(() => { if (!disposed) fail("Word 编辑器加载失败，请重试。") })
    return release
  }, [initialBlob, reloadToken, keyboardHelpId])

  return <div className="word-canvas flex min-h-0 flex-1 flex-col">
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b bg-background pr-3">
      <div ref={toolbar} className="min-w-0 flex-1 overflow-x-auto" />
      <Button type="button" size="sm" variant={fitWidth ? "secondary" : "outline"} aria-pressed={fitWidth} disabled={controlsDisabled} onClick={() => {
        const current = zoomEngine.current
        if (current) current.setZoomMode(current.getZoomState().mode === "fit-width" ? "manual" : "fit-width")
      }}>适应宽度</Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-muted py-4" aria-label="Word 正文">
      <div ref={container} />
    </div>
  </div>
}
