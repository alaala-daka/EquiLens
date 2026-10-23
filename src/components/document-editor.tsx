"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeftIcon, ArrowUpIcon, BotIcon, DownloadIcon, FileTextIcon, LoaderCircleIcon, SaveIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { WordCanvas, type WordCanvasHandle } from "@/components/word-canvas"
import { useIsMobile } from "@/hooks/use-mobile"
import { createDocument, DocumentSessionError, preflightEditorAccess, RevisionConflict, saveDocument } from "@/lib/documents/client"
import { documentTitle, downloadName, errorMessage, type OpenDocument } from "@/lib/documents/types"

function download(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = downloadName(title)
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export function DocumentEditor({ opened, onSaved, onBack, onCopy, onSessionUnavailable, onDirtyChange }: {
  opened: OpenDocument
  onSaved: (saved: OpenDocument) => void
  onBack: () => void
  onCopy: (saved: OpenDocument) => void
  onSessionUnavailable?: (error: DocumentSessionError) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [saved, setSaved] = useState(opened)
  const [initialBlob] = useState(opened.revision.blob)
  const [title, setTitle] = useState(opened.document.title)
  const [prompt, setPrompt] = useState(opened.document.prompt)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [conflict, setConflict] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const canvas = useRef<WordCanvasHandle>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort() }
  }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const markChanged = useCallback(() => { generation.current++; setDirty(true) }, [])
  const editorReady = useCallback(() => setReady(true), [])
  const editorError = useCallback((message: string) => setError(message), [])

  useEffect(() => {
    if (!dirty && !busy) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", protect)
    return () => window.removeEventListener("beforeunload", protect)
  }, [dirty, busy])

  const persist = useCallback(async (exportFile = false, leave = false, asCopy = false) => {
    if (!ready || pending.current) return
    pending.current = true
    setBusy(true)
    setError("")
    const change = generation.current
    const controller = new AbortController()
    request.current = controller
    try {
      // This check must precede both cached downloads and engine serialization.
      await preflightEditorAccess(saved.document.id, { signal: controller.signal, copy: asCopy })
      if (!mounted.current) return
      let result = saved
      if (dirty || asCopy) {
        if (!canvas.current) throw new Error("文档尚未就绪。")
        const blob = await canvas.current.serialize()
        controller.signal.throwIfAborted()
        if (!mounted.current) return
        result = asCopy
          ? await createDocument(blob, `${documentTitle(title)} 副本`, "copy", undefined, prompt, { documentId: saved.document.id, revisionId: saved.revision.id }, { signal: controller.signal })
          : await saveDocument({ documentId: saved.document.id, baseRevision: saved.revision.id, operationId: crypto.randomUUID(), title, prompt, blob }, { signal: controller.signal })
        if (!mounted.current) return
        setSaved(result)
        if (change === generation.current) { setDirty(false); setTitle(result.document.title) }
        onSaved(result)
      }
      if (exportFile) download(result.revision.blob, result.document.title)
      if (asCopy) onCopy(result)
      else if (leave && change === generation.current) onBack()
    } catch (failure) {
      if (mounted.current) {
        setError(errorMessage(failure))
        setConflict(failure instanceof RevisionConflict)
        if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }, [ready, saved, dirty, title, prompt, onSaved, onBack, onCopy, onSessionUnavailable])

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void persist() }
    }
    window.addEventListener("keydown", saveShortcut)
    return () => window.removeEventListener("keydown", saveShortcut)
  }, [persist])

  return (
    <main className="flex h-svh flex-col">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" disabled={busy} onClick={() => dirty ? setLeaving(true) : onBack()}><ArrowLeftIcon />文档</Button>
        <Separator orientation="vertical" className="data-vertical:h-4" />
        <Input aria-label="文档标题" className="min-w-0 flex-1 md:max-w-sm" value={title} disabled={busy} onChange={event => { setTitle(event.target.value); markChanged() }} placeholder="未命名文档" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="link" asChild><a href="/source" target="_blank" rel="noreferrer">源代码</a></Button>
          <Button variant="outline" disabled={!ready || busy || !dirty || conflict} onClick={() => void persist()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}保存</Button>
          <Button variant="outline" disabled={!ready || busy || conflict} onClick={() => void persist(true)}><DownloadIcon />导出 Word</Button>
        </div>
      </header>
      {error && <div role="alert" className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm text-destructive">
        <span>{error}</span>
        {conflict && <Button variant="outline" disabled={busy} onClick={() => void persist(false, false, true)}>另存为新文档</Button>}
      </div>}
      <ResizablePanelGroup orientation={isMobile ? "vertical" : "horizontal"} className="min-h-0 flex-1">
        <ResizablePanel id="editor" defaultSize="70%" minSize="35%">
          <section aria-label="文档编辑器" className="relative h-full" inert={busy}>
            <h1 className="sr-only">文档编辑器</h1>
            {!ready && !error && <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在打开文档</div>}
            <WordCanvas ref={canvas} initialBlob={initialBlob} onReady={editorReady} onChange={markChanged} onError={editorError} />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="调整编辑器与会话区域大小" />
        <ResizablePanel id="agent" defaultSize="30%" minSize="25%">
          <aside aria-label="Agent 会话" className="flex h-full flex-col">
            <header className="flex items-center justify-between border-b px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-medium"><BotIcon className="size-4" />Agent</h2></header>
            <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground"><FileTextIcon className="size-3.5 shrink-0" /><span className="truncate">{documentTitle(title)}</span></div>
            <div className="flex min-h-0 flex-1 overflow-auto"><Empty><EmptyHeader><EmptyMedia variant="icon"><BotIcon /></EmptyMedia><EmptyTitle>暂无会话</EmptyTitle></EmptyHeader></Empty></div>
            <div className="p-4"><InputGroup>
              <InputGroupTextarea aria-label="Agent 消息" placeholder="输入消息…" value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); markChanged() }} />
              <InputGroupAddon align="block-end"><InputGroupButton type="button" size="icon-sm" variant="default" className="ml-auto" disabled aria-label="发送消息"><ArrowUpIcon /></InputGroupButton></InputGroupAddon>
            </InputGroup></div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>保存文档更改？</AlertDialogTitle><AlertDialogDescription>离开前请选择如何处理未保存的更改。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button variant="outline" disabled={busy} onClick={onBack}>放弃更改</Button>
            <Button disabled={busy || !ready || conflict} onClick={() => { setLeaving(false); void persist(false, true) }}>保存并离开</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
