"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeftIcon, BotIcon, DownloadIcon, FileTextIcon, LoaderCircleIcon, SaveIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { EditorLeaveDialog } from "@/components/editor-leave-dialog"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ContractReviewPanel } from "@/components/contract-review-panel"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { WordCanvas, type WordCanvasHandle } from "@/components/word-canvas"
import { useIsMobile } from "@/hooks/use-mobile"
import type { DocumentSessionError } from "@/lib/documents/client"
import {
  createAnonymousEditorAccess, createEditorSessionDependencies, describeEditorFailure, type EditorAccess,
} from "@/lib/documents/editor-access"
import { createEditorSession, type EditorIntent, type EngineState } from "@/lib/documents/editor-session"
import { createUnsavedRegistry, type UnsavedRegistry } from "@/lib/documents/unsaved-registry"

import { documentTitle, downloadName, errorMessage, type OpenDocument } from "@/lib/documents/types"

type EditorCallbacks = {
  onSaved: (saved: OpenDocument) => void
  onBack: () => void
  onCopy: (saved: OpenDocument) => void
  onSessionUnavailable?: (error: DocumentSessionError) => void
  onDirtyChange?: (dirty: boolean) => void
}

export type DocumentEditorAccessProps = {
  /** C3 injects the project access adapter; omitted means the anonymous adapter. */
  access?: EditorAccess
  /** Workspace-level unsaved registry shared with facts, payments, results and task conditions. */
  unsaved?: UnsavedRegistry
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
    async cleanDocx() {
      if (!canvas) throw new Error("文档尚未就绪。")
      return canvas.cleanDocx()
    },
    async locate(paragraphIndex: number, quote: string) {
      if (!canvas) return false
      return canvas.locate(paragraphIndex, quote)
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

export function DocumentEditor({ opened, onSaved, onBack, onCopy, onSessionUnavailable, onDirtyChange, initialReviewTaskId, access: providedAccess, unsaved: providedUnsaved }: {
  opened: OpenDocument
  initialReviewTaskId?: string
} & EditorCallbacks & DocumentEditorAccessProps) {
  const isMobile = useIsMobile()
  const [{ bridge, access, registry, session }] = useState(() => {
    const bridge = createEditorBridge()
    const registry = providedUnsaved ?? createUnsavedRegistry()
    const access = providedAccess ?? createAnonymousEditorAccess({
      download: (blob, title) => bridge.download(blob, title),
      onSessionInvalid: failure => bridge.onSessionUnavailable(failure),
    })
    const session = createEditorSession(createEditorSessionDependencies({
      access, opened, serialize: bridge.serialize, onSaved: bridge.onSaved,
    }))
    return { bridge, access, registry, session }
  })
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const unsaved = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const { title, prompt, dirty, conflict, error, engine, phase } = state
  // Ordinary saves must never replace the engine's loading input.
  const [load, setLoad] = useState(() => ({ blob: opened.revision.blob, token: 0 }))
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const [cleanDialog, setCleanDialog] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [cleanError, setCleanError] = useState("")
  const leaveTrigger = useRef<HTMLButtonElement | null>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const agentInput = useRef<HTMLTextAreaElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const titleFocused = useRef(false)
  const [agentTab, setAgentTab] = useState("review")

  const keyboardHelpId = useId()
  const dialogError = useRef<HTMLDivElement>(null)
  const busy = phase !== "idle" || cleaning || unsaved.saving
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
  // 新建文档默认标题为「未命名文档」，打开后直接把标题交给用户命名，避免列表里多份同名。
  useEffect(() => {
    if (titleFocused.current || !ready || busy) return
    if (title.trim() && title.trim() !== "未命名文档") return
    const input = titleInput.current
    if (!input) return
    titleFocused.current = true
    input.focus()
    input.select()
  }, [ready, busy, title])
  const attachCanvas = useCallback((handle: WordCanvasHandle | null) => { bridge.attachCanvas(handle) }, [bridge])
  const markChanged = useCallback(() => session.markBodyChanged(), [session])
  const engineChanged = useCallback((value: EngineState, message?: string) => session.setEngine(value, message), [session])

  useEffect(() => {
    if (!dirty && !busy && unsaved.entries.length === 0) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", protect)
    return () => window.removeEventListener("beforeunload", protect)
  }, [dirty, busy, unsaved.entries.length])

  const run = useCallback(async (intent: EditorIntent) => {
    const current = bridge.capture()
    const result = await session.run(intent)
    if (!result || !current()) return null
    if (intent === "reload") {
      setLoad(previous => ({ blob: result.revision.blob, token: previous.token + 1 }))
    } else if (intent === "copy") bridge.onCopy(result)
    return result
  }, [bridge, session])

  const locateCitation = useCallback(async (paragraphIndex: number, quote: string) => bridge.locate(paragraphIndex, quote), [bridge])
  // Register the document's own unsaved state so workspace navigation (project
  // switch, cross-panel leave) can use one save-all gate.
  const savePendingDocument = useCallback(async () => {
    const saved = await run("save")
    return Boolean(saved) && !session.getSnapshot().dirty
  }, [run, session])
  useEffect(() => {
    if (!dirty) return
    return registry.register({ id: `document:${opened.document.id}`, label: "文档修改", save: savePendingDocument })
  }, [dirty, registry, opened.document.id, savePendingDocument])
  const executeLeave = async (target: LeaveTarget) => {
    if (session.getSnapshot().phase !== "idle") return
    if (target === "list") bridge.onBack()
    else if (await run("reload")) setLeaveTarget(null)
  }
  const requestLeave = (target: LeaveTarget, trigger: HTMLButtonElement) => {
    const snapshot = session.getSnapshot()
    if (snapshot.phase !== "idle") return
    if (snapshot.dirty || registry.hasUnsaved()) {
      leaveTrigger.current = trigger
      setLeaveTarget(target)
    } else void executeLeave(target)
  }
  const saveAndLeave = async () => {
    if (!leaveTarget) return
    const result = await run("save")
    if (!result || session.getSnapshot().dirty) return
    // Every workspace object (document, facts, payments, results, task
    // conditions) must confirm its saved version before navigation. Failures
    // keep the dialog open; objects that already committed were removed from
    // the registry and are never saved twice.
    if (!(await registry.saveAll()).ok) return
    await executeLeave(leaveTarget)
  }
  const cleanCopy = async () => {
    if (!ready || busy || cleaning || !state.saved) return
    setCleaning(true); setCleanError("")
    try {
      const blob = await bridge.cleanDocx()
      const saved = await access.copy({
        blob, title: documentTitle(title) + "（仅正文副本）", source: "copy", prompt,
        copiedFrom: { documentId: opened.document.id, revisionId: state.saved.revision.id },
      })
      onCopy(saved)
      setCleanDialog(false)
    } catch (failure) {
      setCleanError(errorMessage(failure))
      const described = (access.describeFailure ?? describeEditorFailure)(failure)
      if (described.code === "SESSION_INVALID") access.notifySessionInvalid?.(failure)
    } finally { setCleaning(false) }
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

  const unsupportedDocument = Boolean(error?.includes("暂不支持"))
  const failureNotice = (error || conflict) && <div ref={leaveTarget ? dialogError : undefined} tabIndex={leaveTarget ? -1 : undefined} role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-sm text-destructive">
    <div>
      {error && <p>{error}</p>}
      {unsupportedDocument && <p className="text-muted-foreground">可仅保留正文另存为新文档；图片、页眉页脚、域、修订或合并单元格等格式会丢失，原文档不改。</p>}
      {conflict && <p>文档已有较新版本，无法覆盖保存或导出。请另存为新文档。</p>}
    </div>
    {unsupportedDocument && !leaveTarget && <Button type="button" variant="outline" disabled={busy || cleaning} onClick={() => { setCleanError(""); setCleanDialog(true) }}>仅保留正文另存</Button>}
    {conflict && <Button variant="outline" disabled={busy || !ready} onClick={() => void run("copy")}>另存为新文档</Button>}
    {engine === "failed" && !leaveTarget && <Button variant="outline" disabled={busy} onClick={event => requestLeave("reload", event.currentTarget)}>重新加载</Button>}
  </div>

  const unsavedFailureNotice = unsaved.failures.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">
    {unsaved.failures.map(failure => <p key={failure.id}>{failure.label}保存失败：{failure.message}</p>)}
  </div>

  return (
    <main className="flex h-svh min-w-0 flex-col overflow-hidden">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button ref={backButton} variant="ghost" disabled={busy} onClick={event => requestLeave("list", event.currentTarget)}><ArrowLeftIcon />文档</Button>
        <Separator orientation="vertical" className="data-vertical:h-4" />
        <Input ref={titleInput} aria-label="文档标题" className="min-w-0 flex-1 basis-full md:basis-auto md:max-w-sm" value={title} disabled={busy} inert={busy} onChange={event => session.editTitle(event.target.value)} placeholder="未命名文档" />
        <Badge variant="outline" role="status" aria-live="polite">{status}</Badge>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
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
            <p id={keyboardHelpId} className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">正文中按 F6 转到备注，Shift+F6 转到文档操作。</p>
            {engine === "loading" && <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm" aria-hidden="true"><LoaderCircleIcon className="size-4 animate-spin" />正在打开文档</div>}
            <WordCanvas ref={attachCanvas} initialBlob={load.blob} reloadToken={load.token} onStateChange={engineChanged} onChange={markChanged} keyboardHelpId={keyboardHelpId} keyboardBlocked={busy || !!leaveTarget} controlsDisabled={!ready || busy || !!leaveTarget} onFocusShortcut={destination => {
              if (destination === "agent") {
                setAgentTab("notes")
                requestAnimationFrame(() => agentInput.current?.focus())
                return true
              }
              const control = backButton.current
              if (!control || control.disabled) return false
              control.focus()
              return document.activeElement === control
            }} />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="调整编辑器与会话区域大小" />
        <ResizablePanel id="agent" defaultSize="30%" minSize="25%">
          <aside aria-label="Agent 会话" tabIndex={0} className="h-full min-h-0 min-w-0 overflow-auto focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring">
            {/* Scroll the complete column when a short panel cannot fit its input. */}
            <div className="flex min-h-full min-w-0 flex-col">
              <header className="flex shrink-0 items-center justify-between border-b px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-medium"><BotIcon className="size-4" />Agent</h2></header>
              <div className="flex min-w-0 shrink-0 items-start gap-2 border-b px-4 py-3 text-xs text-muted-foreground"><FileTextIcon className="size-3.5 shrink-0" /><span className="min-w-0 whitespace-normal break-all">{documentTitle(title)}</span></div>
              <Tabs value={agentTab} onValueChange={setAgentTab} className="flex-1">
                <TabsList className="mx-4 mt-3"><TabsTrigger value="review">业务处理</TabsTrigger><TabsTrigger value="notes">备注</TabsTrigger></TabsList>
                <TabsContent value="review" forceMount hidden={agentTab !== "review"}>
                  <ContractReviewPanel key={state.saved.document.id + ":" + state.saved.revision.id} documentId={state.saved.document.id} revisionId={state.saved.revision.id} dirty={dirty} busy={busy || !ready || conflict} initialTaskId={initialReviewTaskId} onSessionUnavailable={onSessionUnavailable} onLocateCitation={locateCitation} />
                </TabsContent>
                <TabsContent value="notes" forceMount hidden={agentTab !== "notes"} className="p-4" inert={busy}><InputGroup>
                  <InputGroupTextarea ref={agentInput} aria-label="文档备注" placeholder="输入备注…" value={prompt} disabled={busy} onChange={event => session.editPrompt(event.target.value)} />
                </InputGroup></TabsContent>
              </Tabs>
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
      <EditorLeaveDialog open={leaveTarget !== null} busy={busy} canSave={ready && !conflict} onCancel={() => setLeaveTarget(null)} onDiscard={() => { if (leaveTarget) { registry.discardAll(); void executeLeave(leaveTarget) } }} onSave={() => void saveAndLeave()} onCloseAutoFocus={restoreLeaveFocus}>
        {failureNotice}
        {unsavedFailureNotice}
      </EditorLeaveDialog>
      <AlertDialog open={cleanDialog} onOpenChange={value => { if (!cleaning) setCleanDialog(value) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>仅保留正文另存？</AlertDialogTitle>
            <AlertDialogDescription>将当前正文重建为一个新的 Word 文档。图片、页眉页脚、域、修订、文本框和合并单元格等格式会丢失；原文档及其版本不变。</AlertDialogDescription>
          </AlertDialogHeader>
          {cleanError && <p role="alert" className="text-sm text-destructive">{cleanError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>取消</AlertDialogCancel>
            <Button type="button" disabled={cleaning || !ready} onClick={() => void cleanCopy()}>{cleaning ? "正在另存" : "确认另存"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
