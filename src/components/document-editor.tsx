"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeftIcon, ArrowUpIcon, BotIcon, DownloadIcon, FileTextIcon, LoaderCircleIcon, SaveIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EditorLeaveDialog } from "@/components/editor-leave-dialog"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { WordCanvas, type WordCanvasHandle } from "@/components/word-canvas"
import { useIsMobile } from "@/hooks/use-mobile"
import { createDocument, DocumentSessionError, preflightEditorAccess, saveDocument } from "@/lib/documents/client"
import { createEditorSession, type EditorIntent, type EngineState } from "@/lib/documents/editor-session"

import { documentTitle, downloadName, type OpenDocument } from "@/lib/documents/types"

type EditorCallbacks = {
  onSaved: (saved: OpenDocument) => void
  onBack: () => void
  onCopy: (saved: OpenDocument) => void
  onSessionUnavailable?: (error: DocumentSessionError) => void
  onDirtyChange?: (dirty: boolean) => void
}

// Connect React callbacks and the imperative canvas only after commit. The
// controller can then be constructed once without accessing refs in render.
function createEditorBridge() {
  let callbacks: EditorCallbacks | null = null
  let canvas: WordCanvasHandle | null = null
  let generation = 0
  let active = false
  const downloads = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    connect(next: EditorCallbacks) { callbacks = next },
    attachCanvas(handle: WordCanvasHandle | null) { canvas = handle },
    activate() { active = true; generation++ },
    capture() {
      const captured = generation
      return () => active && generation === captured
    },
    async serialize() {
      if (!canvas) throw new Error("文档尚未就绪。")
      return canvas.serialize()
    },
    onSaved(saved: OpenDocument) { callbacks?.onSaved(saved) },
    onBack() { callbacks?.onBack() },
    onCopy(saved: OpenDocument) { callbacks?.onCopy(saved) },
    onSessionUnavailable(error: DocumentSessionError) { callbacks?.onSessionUnavailable?.(error) },
    download(blob: Blob, title: string) {
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      try {
        link.href = url
        link.download = downloadName(title)
        document.body.append(link)
        link.click()
        downloads.set(url, setTimeout(() => {
          URL.revokeObjectURL(url)
          downloads.delete(url)
        }, 60000))
      } catch (failure) {
        URL.revokeObjectURL(url)
        throw failure
      } finally { link.remove() }
    },
    dispose() {
      active = false
      generation++
      callbacks = null
      for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url) }
      downloads.clear()
    },
  }
}

const phaseLabel = {
  checking: "正在核对访问权限",
  serializing: "正在保存",
  saving: "正在保存",
  exporting: "正在导出",
} as const

type LeaveTarget = "list" | "reload"

export function DocumentEditor({ opened, onSaved, onBack, onCopy, onSessionUnavailable, onDirtyChange }: {
  opened: OpenDocument
} & EditorCallbacks) {
  const isMobile = useIsMobile()
  const [{ bridge, session }] = useState(() => {
    const bridge = createEditorBridge()
    const session = createEditorSession({
      opened,
      serialize: bridge.serialize,
      preflight: options => preflightEditorAccess(opened.document.id, options),
      save: saveDocument,
      copy: createDocument,
      download: bridge.download,
      onSaved: bridge.onSaved,
      onSessionUnavailable: bridge.onSessionUnavailable,
    })
    return { bridge, session }
  })
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const { title, prompt, dirty, conflict, error, engine, phase } = state
  // Ordinary saves must never replace the engine's loading input.
  const [load, setLoad] = useState(() => ({ blob: opened.revision.blob, token: 0 }))
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const leaveTrigger = useRef<HTMLButtonElement | null>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const agentInput = useRef<HTMLTextAreaElement>(null)

  const keyboardHelpId = useId()
  const dialogError = useRef<HTMLDivElement>(null)
  const busy = phase !== "idle"
  const ready = engine === "ready"
  const status = phase !== "idle" ? phaseLabel[phase] : engine === "loading" ? "正在打开文档" : engine === "failed" ? "编辑器不可用" : dirty ? "未保存" : "已保存"

  useLayoutEffect(() => {
    bridge.connect({ onSaved, onBack, onCopy, onSessionUnavailable, onDirtyChange })
  }, [bridge, onSaved, onBack, onCopy, onSessionUnavailable, onDirtyChange])
  useLayoutEffect(() => {
    bridge.activate()
    session.activate()
    return () => { session.dispose(); bridge.dispose() }
  }, [bridge, session])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const attachCanvas = useCallback((handle: WordCanvasHandle | null) => { bridge.attachCanvas(handle) }, [bridge])
  const markChanged = useCallback(() => session.markBodyChanged(), [session])
  const engineChanged = useCallback((value: EngineState, message?: string) => session.setEngine(value, message), [session])

  useEffect(() => {
    if (!dirty && !busy) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", protect)
    return () => window.removeEventListener("beforeunload", protect)
  }, [dirty, busy])

  const run = useCallback(async (intent: EditorIntent) => {
    const current = bridge.capture()
    const result = await session.run(intent)
    if (!result || !current()) return null
    if (intent === "reload") {
      setLoad(previous => ({ blob: result.revision.blob, token: previous.token + 1 }))
    } else if (intent === "copy") bridge.onCopy(result)
    return result
  }, [bridge, session])

  const executeLeave = async (target: LeaveTarget) => {
    if (session.getSnapshot().phase !== "idle") return
    if (target === "list") bridge.onBack()
    else if (await run("reload")) setLeaveTarget(null)
  }
  const requestLeave = (target: LeaveTarget, trigger: HTMLButtonElement) => {
    const snapshot = session.getSnapshot()
    if (snapshot.phase !== "idle") return
    if (snapshot.dirty) {
      leaveTrigger.current = trigger
      setLeaveTarget(target)
    } else void executeLeave(target)
  }
  const saveAndLeave = async () => {
    if (!leaveTarget) return
    const result = await run("save")
    if (result && !session.getSnapshot().dirty) await executeLeave(leaveTarget)
  }
  const restoreLeaveFocus = (event: Event) => {
    event.preventDefault()
    const trigger = leaveTrigger.current
    if (trigger?.isConnected && !trigger.disabled) trigger.focus()
    else if (backButton.current?.isConnected && !backButton.current.disabled) backButton.current.focus()
  }

  useEffect(() => {
    if (!leaveTarget || busy || !error) return
    const frame = requestAnimationFrame(() => dialogError.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [leaveTarget, busy, error])

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      // Capture before the Word engine so one keystroke has one save owner.
      event.stopImmediatePropagation()
      const snapshot = session.getSnapshot()
      if (!event.repeat && snapshot.engine === "ready" && snapshot.phase === "idle" && snapshot.dirty && !snapshot.conflict) void run("save")
    }
    window.addEventListener("keydown", saveShortcut, true)
    return () => window.removeEventListener("keydown", saveShortcut, true)
  }, [run, session])

  const failureNotice = (error || conflict) && <div ref={leaveTarget ? dialogError : undefined} tabIndex={leaveTarget ? -1 : undefined} role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-sm text-destructive">
    <div>
      {error && <p>{error}</p>}
      {conflict && <p>文档已有较新版本，无法覆盖保存或导出。请另存为新文档。</p>}
    </div>
    {conflict && <Button variant="outline" disabled={busy || !ready} onClick={() => void run("copy")}>另存为新文档</Button>}
    {engine === "failed" && !leaveTarget && <Button variant="outline" disabled={busy} onClick={event => requestLeave("reload", event.currentTarget)}>重新加载</Button>}
  </div>

  return (
    <main className="flex h-svh min-w-0 flex-col">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button ref={backButton} variant="ghost" disabled={busy} onClick={event => requestLeave("list", event.currentTarget)}><ArrowLeftIcon />文档</Button>
        <Separator orientation="vertical" className="data-vertical:h-4" />
        <Input aria-label="文档标题" className="min-w-0 flex-1 basis-full md:basis-auto md:max-w-sm" value={title} disabled={busy} inert={busy} onChange={event => session.editTitle(event.target.value)} placeholder="未命名文档" />
        <Badge variant="outline" role="status" aria-live="polite">{status}</Badge>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <Button variant="link" asChild><a href="/source" target="_blank" rel="noreferrer">源代码</a></Button>
          <Button variant="outline" disabled={!ready || busy || !dirty || conflict} onClick={() => void run("save")}><SaveIcon />保存</Button>
          <Button variant="outline" disabled={!ready || busy || conflict} onClick={() => void run("export")}><DownloadIcon />导出 Word</Button>
        </div>
      </header>
      {!leaveTarget && failureNotice}
      <ResizablePanelGroup orientation={isMobile ? "vertical" : "horizontal"} className="min-h-0 min-w-0 flex-1">
        <ResizablePanel id="editor" defaultSize="70%" minSize="35%">
          <section aria-label="文档编辑器" aria-describedby={keyboardHelpId} aria-keyshortcuts="F6 Shift+F6" className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden" inert={busy}
>
            <h1 className="sr-only">文档编辑器</h1>
            <p id={keyboardHelpId} className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">正文中按 F6 转到 Agent 消息，Shift+F6 转到文档操作。</p>
            {engine === "loading" && <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm" aria-hidden="true"><LoaderCircleIcon className="size-4 animate-spin" />正在打开文档</div>}
            <WordCanvas ref={attachCanvas} initialBlob={load.blob} reloadToken={load.token} onStateChange={engineChanged} onChange={markChanged} keyboardHelpId={keyboardHelpId} keyboardBlocked={busy || !!leaveTarget} onFocusShortcut={destination => { const control = destination === "agent" ? agentInput.current : backButton.current; if (!control || control.disabled) return false; control.focus(); return document.activeElement === control }} />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="调整编辑器与会话区域大小" />
        <ResizablePanel id="agent" defaultSize="30%" minSize="25%">
          <aside aria-label="Agent 会话" tabIndex={0} className="h-full min-h-0 min-w-0 overflow-auto focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring">
            {/* Scroll the complete column when a short panel cannot fit its input. */}
            <div className="flex min-h-full min-w-0 flex-col">
              <header className="flex shrink-0 items-center justify-between border-b px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-medium"><BotIcon className="size-4" />Agent</h2></header>
              <div className="flex min-w-0 shrink-0 items-start gap-2 border-b px-4 py-3 text-xs text-muted-foreground"><FileTextIcon className="size-3.5 shrink-0" /><span className="min-w-0 whitespace-normal break-all">{documentTitle(title)}</span></div>
              <div className="flex flex-1"><Empty><EmptyHeader><EmptyMedia variant="icon"><BotIcon /></EmptyMedia><EmptyTitle>暂无会话</EmptyTitle></EmptyHeader></Empty></div>
              <div className="shrink-0 p-4" inert={busy}><InputGroup>
                <InputGroupTextarea ref={agentInput} aria-label="Agent 消息" placeholder="输入消息…" value={prompt} disabled={busy} onChange={event => session.editPrompt(event.target.value)} />
                <InputGroupAddon align="block-end"><InputGroupButton type="button" size="icon-sm" variant="default" className="ml-auto" disabled aria-label="发送消息"><ArrowUpIcon /></InputGroupButton></InputGroupAddon>
              </InputGroup></div>
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
      <EditorLeaveDialog open={leaveTarget !== null} busy={busy} canSave={ready && !conflict} onCancel={() => setLeaveTarget(null)} onDiscard={() => { if (leaveTarget) void executeLeave(leaveTarget) }} onSave={() => void saveAndLeave()} onCloseAutoFocus={restoreLeaveFocus}>
        {failureNotice}
      </EditorLeaveDialog>
    </main>
  )
}
