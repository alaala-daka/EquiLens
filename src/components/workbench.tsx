"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { BookOpenIcon, FileTextIcon, FolderOpenIcon, PlusIcon, ScaleIcon, UploadIcon, LoaderCircleIcon } from "lucide-react"

import { AccountEntry } from "@/components/auth/account-entry"
import { ProjectHostProvider, useProjectHost } from "@/components/business/platform/project-host"
import { ProjectDocumentsWorkspace } from "@/components/business/platform/project-documents-workspace"
import { workspaceSurface } from "@/components/business/platform/project-retention"
import { ProjectSwitcher } from "@/components/business/platform/project-switcher"
import { DocumentEditor } from "@/components/document-editor"
import { ContractReviewHistory } from "@/components/contract-review-history"
import { DocumentList } from "@/components/document-list"
import { DocumentSessionDialog, type RetentionConfirmationRequest } from "@/components/document-session-dialog"
import { blankDocx } from "@/lib/documents/docx"
import { createDocument as persistDocument, DocumentSessionError, getDocumentSession, restartDocumentSession, setDocumentContext, listDocuments, openDocument } from "@/lib/documents/client"
import type { AnonymousSessionView } from "@/lib/documents/session-types"
import { readCreatedSession } from "@/lib/documents/session-transition"
import { downloadName, errorMessage, type OpenDocument } from "@/lib/documents/types"
import { validateDocx } from "@/lib/documents/validate"
import { selectDocuments } from "@/lib/documents/list-view"
import { createDocumentListStore } from "@/lib/documents/list-store"
import { createDocumentOperations, type OperationDependencies } from "@/lib/documents/operations"
import { createUnsavedRegistry } from "@/lib/documents/unsaved-registry"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"

// Stores are constructed during render; callbacks are connected after commit.
// Their event handlers never read React refs while constructing the stores.
function createSessionBridge() {
  let handlers: { create: OperationDependencies["create"]; unavailable: (error: DocumentSessionError) => void } | null = null
  return {
    connect(next: NonNullable<typeof handlers>) { handlers = next },
    create: ((...args) => handlers ? handlers.create(...args) : Promise.reject(new Error("正在读取会话。"))) as OperationDependencies["create"],
    unavailable(error: DocumentSessionError) { handlers?.unavailable(error) },
  }
}

export function Workbench() {
  const [registry] = useState(() => createUnsavedRegistry())
  return <ProjectHostProvider registry={registry}><WorkspaceRouter registry={registry} /></ProjectHostProvider>
}

function WorkspaceRouter({ registry }: { registry: ReturnType<typeof createUnsavedRegistry> }) {
  const host = useProjectHost()
  // Signing in keeps the anonymous workspace reachable; signing out returns to it.
  const [anonymous, setAnonymous] = useState(false)
  async function openAnonymous() {
    if (!(await registry.saveAll()).ok) return false
    setAnonymous(true)
    return true
  }
  async function openProject() {
    if (!(await registry.saveAll()).ok) return false
    setAnonymous(false)
    return true
  }
  if (workspaceSurface(anonymous, host.status, host.currentProject) === "anonymous") {
    return <AnonymousWorkbench workspaceRegistry={registry} onOpenProject={host.status === "ready" ? openProject : undefined} />
  }
  if (host.currentProject) return <ProjectDocumentsWorkspace key={host.currentProject.id} project={host.currentProject} accessBlocked={host.status !== "ready"} registry={registry} onOpenAnonymous={openAnonymous} />
  return <main className="flex min-h-svh flex-col"><header className="flex h-16 items-center justify-between border-b px-6"><span className="text-sm font-medium">衡鉴</span><div className="flex items-center gap-3"><ProjectSwitcher /><Button variant="outline" size="sm" onClick={() => void openAnonymous()}><FileTextIcon />匿名工作台</Button><AccountEntry /></div></header>{host.status === "loading" && <p role="status" className="p-6 text-sm">正在读取项目</p>}{host.status === "error" && <div role="alert" className="flex flex-col items-start gap-3 p-6 text-sm"><p>{host.error || "项目列表暂不可用，请重试。"}</p><Button variant="outline" size="sm" onClick={() => void host.refresh()}>重试</Button></div>}</main>
}

function AnonymousWorkbench({ workspaceRegistry, onOpenProject }: { workspaceRegistry: ReturnType<typeof createUnsavedRegistry>; onOpenProject?: () => Promise<boolean> }) {
  const [session, setSession] = useState<AnonymousSessionView | null>(null)
  const sessionRef = useRef<AnonymousSessionView | null>(null)
  const [sessionError, setSessionError] = useState("")
  const [navigationError, setNavigationError] = useState("")
  const [sessionLoading, setSessionLoading] = useState(true)
  const [sessionRefreshNeeded, setSessionRefreshNeeded] = useState(false)
  const [unsavedNotice, setUnsavedNotice] = useState(false)
  const dirty = useRef(false)
  const [confirmation, setConfirmation] = useState<RetentionConfirmationRequest | null>(null)
  const [confirming, setConfirming] = useState(false)
  const resolver = useRef<((accepted: boolean) => void) | null>(null)
  const sessionRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null })
  const [bridge] = useState(createSessionBridge)
  const [restarting, setRestarting] = useState(false)
  const [restartDialog, setRestartDialog] = useState(false)
  const restartPending = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const downloadRequest = useRef<AbortController | null>(null)
  const decide = useCallback((accepted: boolean) => { resolver.current?.(accepted) }, [])
  const requestConfirmation = useCallback((request: RetentionConfirmationRequest) => new Promise<boolean>(resolve => {
    resolver.current?.(false)
    let settled = false
    const settle = (accepted: boolean) => {
      if (settled) return
      settled = true
      request.signal.removeEventListener("abort", abort)
      resolver.current = null
      setConfirmation(null)
      setConfirming(false)
      resolve(accepted)
    }
    const abort = () => settle(false)
    resolver.current = settle
    if (request.signal.aborted) settle(false)
    else { request.signal.addEventListener("abort", abort, { once: true }); setConfirming(true); setConfirmation(request) }
  }), [])
  const [listStore] = useState(() => createDocumentListStore(async signal => {
    try { return await listDocuments(signal) }
    catch (failure) { if (failure instanceof DocumentSessionError) bridge.unavailable(failure); throw failure }
  }))
  const list = useSyncExternalStore(listStore.subscribe, listStore.getSnapshot, listStore.getSnapshot)
  const [opened, setOpened] = useState<OpenDocument | null>(null)
  const [reviewSelection, setReviewSelection] = useState<{ documentId: string; taskId: string } | null>(null)
  const [operations] = useState(() => createDocumentOperations({
    list: listStore,
    blank: blankDocx,
    validate: validateDocx,
    create: bridge.create,
    open: async (id, signal) => {
      try { return await openDocument(id, signal) }
      catch (failure) { if (failure instanceof DocumentSessionError) bridge.unavailable(failure); throw failure }
    },
    onOpened: setOpened,
  }))
  const operationState = useSyncExternalStore(operations.subscribe, operations.getSnapshot, operations.getSnapshot)
  const documents = list.documents
  const listReady = list.kind === "ready" && session?.canRead === true && !sessionRefreshNeeded
  const busy = operationState.operation !== null || restarting || downloading
  async function switchWorkspace() {
    if (busy || !onOpenProject) return
    setNavigationError("")
    if (!(await onOpenProject())) setNavigationError("存在未保存的修改，切换已取消。")
  }
  const error = operationState.error ? errorMessage(operationState.error) : ""
  const fileInput = useRef<HTMLInputElement>(null)
  const initiatingControl = useRef<HTMLButtonElement | null>(null)
  const [focusReturn, setFocusReturn] = useState<HTMLButtonElement | null>(null)
  const [activeTab, setActiveTab] = useState("documents")
  const [query, setQuery] = useState("")
  const listSearch = useRef<HTMLInputElement>(null)
  const documentsTab = useRef<HTMLButtonElement>(null)
  const returnToList = useRef(false)
  const visibleDocuments = selectDocuments(documents, query)
  useEffect(() => {
    if (opened || !returnToList.current) return
    const frame = requestAnimationFrame(() => {
      const search = listSearch.current
      if (search && !search.disabled) search.focus()
      else documentsTab.current?.focus()
      returnToList.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [opened])
  function runCreate(file?: File) {
    const trigger = initiatingControl.current
    void operations.create(file).finally(() => setFocusReturn(trigger))
  }
  function beginCreate(trigger: HTMLButtonElement) {
    initiatingControl.current = trigger
    runCreate()
  }
  useEffect(() => {
    if (!focusReturn || busy || confirmation) return
    const frame = requestAnimationFrame(() => {
      if (focusReturn.isConnected && !focusReturn.disabled) focusReturn.focus()
      setFocusReturn(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusReturn, busy, confirmation])
  const clearWorkspace = useCallback(() => {
    operations.cancel(); listStore.reset(); downloadRequest.current?.abort()
    resolver.current?.(false)
    if (dirty.current) setUnsavedNotice(true)
    dirty.current = false
    setOpened(null); setQuery(""); setActiveTab("documents"); setRestartDialog(false)
    setReviewSelection(null)
    if (fileInput.current) fileInput.current.value = ""
  }, [operations, listStore])
  const acceptSession = useCallback((view: AnonymousSessionView) => {
    const previous = sessionRef.current
    const changed = previous !== null && previous.contextId !== view.contextId
    if (changed || (previous?.canRead && !view.canRead) || (previous?.canSave && !view.canSave)) clearWorkspace()
    sessionRef.current = view
    setDocumentContext(view.contextId)
    setSession(view)
    setSessionRefreshNeeded(false)
    setSessionError(view.issue?.message ?? "")
    return changed
  }, [clearWorkspace])
  const refreshSession = useCallback(async () => {
    if (restartPending.current) return
    sessionRequest.current.controller?.abort()
    const generation = ++sessionRequest.current.generation
    const controller = new AbortController()
    sessionRequest.current.controller = controller
    setSessionLoading(true)
    try {
      const view = await getDocumentSession(controller.signal)
      if (controller.signal.aborted || generation !== sessionRequest.current.generation) return
      acceptSession(view)
      if (view.canRead) await listStore.refresh()
    } catch (failure) {
      if (!controller.signal.aborted && generation === sessionRequest.current.generation) setSessionError(errorMessage(failure))
    } finally {
      if (generation === sessionRequest.current.generation) setSessionLoading(false)
    }
  }, [acceptSession, listStore])
  const unavailable = useCallback((failure: DocumentSessionError) => {
    setSessionError(failure.message)
    if (failure.code === "RETENTION_EXPIRED" || failure.code === "SESSION_CHANGED" || failure.code === "RETENTION_READ_ONLY" || failure.code === "LEGACY_RETENTION_PENDING") {
      clearWorkspace()
      setDocumentContext("")
      setSession(null)
    }
    if (failure.session) acceptSession(failure.session)
    void refreshSession()
  }, [clearWorkspace, refreshSession, acceptSession])
  useEffect(() => {
    bridge.connect({ unavailable, create: async (blob, title, source, fileName, signal) => {
      try {
        const generation = sessionRequest.current.generation
        const view = await getDocumentSession(signal)
        signal.throwIfAborted()
        if (generation !== sessionRequest.current.generation) throw new DocumentSessionError("会话已重新核对，请重试并确认期限。", 409, "RETENTION_CONFIRMATION_CHANGED")
        if (acceptSession(view)) throw new DocumentSessionError("会话已变更，请重新操作。", 409, "SESSION_CHANGED", view)
        if (!view.canCreate || !view.confirmation) throw new DocumentSessionError(view.issue?.message ?? "当前无法新建文档。", 403, view.issue?.code ?? "RETENTION_READ_ONLY", view)
        const accepted = await requestConfirmation({ consent: view.confirmation, signal })
        signal.throwIfAborted()
        if (!accepted) return null
        const saved = await persistDocument(blob, title, source, fileName, "", undefined, { signal, retentionConsent: view.confirmation })
        signal.throwIfAborted()
        setSessionLoading(true)
        const metadata = readCreatedSession(sessionRequest.current, signal, getDocumentSession)
        const metadataGeneration = sessionRequest.current.generation
        try {
          const current = await metadata
          if (!current) return null
          const changed = acceptSession(current)
          if (changed || !current.canSave) return null
          signal.throwIfAborted()
          return saved
        } catch (failure) {
          signal.throwIfAborted()
          // The document POST succeeded. Keep that saved document visible and
          // ask for a session refresh; do not report a failed create or retry it.
          if (metadataGeneration === sessionRequest.current.generation) {
            listStore.upsert(saved.document)
            setSessionRefreshNeeded(true)
            setSessionError(`读取文档期限失败：${errorMessage(failure)}`)
          }
          return null
        } finally {
          if (metadataGeneration === sessionRequest.current.generation) setSessionLoading(false)
        }
      } catch (failure) { if (failure instanceof DocumentSessionError) unavailable(failure); throw failure }
    } })
  }, [bridge, acceptSession, requestConfirmation, unavailable, listStore])
  useEffect(() => {
    const requestState = sessionRequest.current
    const refresh = () => { void refreshSession() }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      ++requestState.generation; requestState.controller?.abort()
      listStore.cancel(); operations.cancel(); downloadRequest.current?.abort(); resolver.current?.(false)
      window.removeEventListener("focus", refresh)
    }
  }, [listStore, operations, refreshSession])
  useEffect(() => {
    const deadline = session?.state === "legacy_export" ? session.exportUntil : session?.expiresAt
    if (!deadline || session?.state === "expired") return
    // Browser time only schedules a server check; capabilities come from the response.
    const timer = window.setTimeout(() => void refreshSession(), Math.min(2147483647, Math.max(1000, Date.parse(deadline) - Date.now())))
    return () => window.clearTimeout(timer)
  }, [session, refreshSession])

  async function restart() {
    if (restartPending.current || !sessionRef.current?.canRestart) return
    restartPending.current = true; setRestarting(true); setSessionError("")
    sessionRequest.current.controller?.abort()
    const generation = ++sessionRequest.current.generation
    const controller = new AbortController()
    sessionRequest.current.controller = controller
    try {
      const view = await restartDocumentSession(controller.signal)
      if (controller.signal.aborted || generation !== sessionRequest.current.generation) return
      clearWorkspace(); setUnsavedNotice(false); acceptSession(view)
      restartPending.current = false
      await refreshSession()
    } catch (failure) {
      if (!controller.signal.aborted && generation === sessionRequest.current.generation) setSessionError(errorMessage(failure))
    } finally { restartPending.current = false; setRestarting(false) }
  }

  async function downloadSaved(id: string) {
    if (downloadRequest.current || !sessionRef.current?.canRead) return
    const controller = new AbortController()
    downloadRequest.current = controller; setDownloading(true); setSessionError("")
    try {
      const saved = await openDocument(id, controller.signal)
      controller.signal.throwIfAborted()
      const url = URL.createObjectURL(saved.revision.blob)
      const link = document.createElement("a")
      link.href = url; link.download = downloadName(saved.document.title)
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (failure) {
      if (!controller.signal.aborted) { if (failure instanceof DocumentSessionError) unavailable(failure); else setSessionError(errorMessage(failure)) }
    } finally { if (downloadRequest.current === controller) { downloadRequest.current = null; setDownloading(false) } }
  }

  const recordSaved = useCallback((saved: OpenDocument) => {
    listStore.upsert(saved.document)
  }, [listStore])
  const editorBack = useCallback(() => { dirty.current = false; returnToList.current = true; setOpened(null) }, [])
  const editorCopy = useCallback((saved: OpenDocument) => {
    listStore.upsert(saved.document)
    dirty.current = false
    setOpened(saved)
  }, [listStore])
  const editorDirtyChanged = useCallback((value: boolean) => { dirty.current = value }, [])

  if (opened && session?.canSave) {
    return (
        <DocumentEditor key={opened.document.id} opened={opened} onSaved={recordSaved} onBack={editorBack} onCopy={editorCopy} onSessionUnavailable={unavailable} onDirtyChange={editorDirtyChanged} initialReviewTaskId={reviewSelection?.documentId === opened.document.id ? reviewSelection.taskId : undefined} unsaved={workspaceRegistry} />
    )
  }

  return (
    <main className="flex min-h-svh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ScaleIcon className="size-5" />
          衡鉴 <span className="font-normal text-muted-foreground">EquiLens</span>
        </div>
        <div className="flex items-center gap-3">
          {onOpenProject ? <Button variant="outline" size="sm" onClick={() => void switchWorkspace()}><FolderOpenIcon />项目工作区</Button> : <ProjectSwitcher />}
          <AccountEntry />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-6">
        <DocumentSessionDialog request={confirmation} onDecision={decide} />
        <input ref={fileInput} type="file" accept=".docx" aria-label="选择 Word 文件" className="hidden" disabled={!listReady || busy || !session?.canCreate} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) runCreate(file) }} />
        {sessionError && <div className="mb-4 flex items-center gap-2"><p role="alert" className="text-sm text-destructive">{sessionError}</p><Button variant="outline" disabled={busy} onClick={() => void refreshSession()}>重试</Button></div>}
        {navigationError && <p role="alert" className="mb-4 text-sm text-destructive">{navigationError}</p>}
        {unsavedNotice && <p role="alert" className="mb-4 text-sm">会话访问已结束，未保存的更改未能保存。</p>}
        {session?.state === "legacy_export" && <p role="status" className="mb-4 text-sm">文档仅可下载。导出截止：{session.exportUntil ? new Date(session.exportUntil).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</p>}
        {session?.state === "expired" && <AlertDialog open={restartDialog} onOpenChange={setRestartDialog}>
          <AlertDialogTrigger asChild><Button variant="outline" className="mb-4 self-start" disabled={!session.canRestart || busy}>开始新会话</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>开始新会话？</AlertDialogTitle><AlertDialogDescription>旧资料不会迁入新会话，新会话无法访问旧资料。</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel disabled={restarting}>取消</AlertDialogCancel><Button disabled={!session.canRestart || restarting} onClick={() => void restart()}>{restarting ? "正在开始新会话" : "确认并继续"}</Button></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>}
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
        {operationState.operation && !confirming && <div role="status" className="mb-4 flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />{operationState.operation === "creating" ? "正在新建文档" : operationState.operation === "importing" ? "正在导入文档" : "正在打开文档"}<Button variant="ghost" size="sm" onClick={() => operations.cancel()}>取消</Button></div>}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 gap-6">
          <TabsList>
            <TabsTrigger ref={documentsTab} value="documents"><FileTextIcon />文档</TabsTrigger>
            <TabsTrigger value="standards"><BookOpenIcon />规范库</TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-lg font-semibold">文档</h1>
              <div className="flex gap-2">
                <Button variant="outline" disabled={!listReady || busy || !session?.canCreate} onClick={event => { initiatingControl.current = event.currentTarget; fileInput.current?.click() }}><UploadIcon />导入 Word</Button>
                <Button disabled={!listReady || busy || !session?.canCreate} onClick={event => beginCreate(event.currentTarget)}><PlusIcon />新建文档</Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input ref={listSearch} type="search" aria-label="搜索文档" placeholder="搜索文档" value={query} disabled={!listReady} onChange={event => setQuery(event.target.value)} />
              {query && <Button variant="outline" onClick={() => setQuery("")}>清空搜索</Button>}
            </div>
            {list.error && <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-destructive">{list.kind === "ready" ? `刷新文档失败：${list.error}` : list.error}</p>
              <Button variant="outline" disabled={busy} onClick={() => void refreshSession()}>重试</Button>
            </div>}
            {!session ? (sessionLoading ? <div role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取会话</div> : null) : !session.canRead ? null : list.kind === "loading" ? <div role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取文档</div> : list.kind === "initial-error" ? null : documents.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>暂无文档</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" disabled={busy || !session.canCreate || sessionRefreshNeeded} onClick={event => beginCreate(event.currentTarget)}><PlusIcon />创建文档</Button>
                </EmptyContent>
              </Empty>
            ) : (
              visibleDocuments.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                    <EmptyTitle>未找到文档</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={() => setQuery("")}>清空搜索</Button>
                  </EmptyContent>
                </Empty>
              ) : <DocumentList documents={visibleDocuments} busy={busy || sessionRefreshNeeded} onOpen={session.state === "legacy_export" ? undefined : id => { setReviewSelection(null); void operations.open(id) }} onDownload={session.state === "legacy_export" ? id => void downloadSaved(id) : undefined} />
            )}
            {listReady && session?.canSave && <ContractReviewHistory key={session.contextId} busy={busy} onSessionUnavailable={unavailable} onOpen={(documentId, taskId) => { setReviewSelection({ documentId, taskId }); void operations.open(documentId) }} />}
          </TabsContent>
          <TabsContent value="standards" className="flex flex-col gap-6">
            <h1 className="text-lg font-semibold">规范库</h1>
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BookOpenIcon /></EmptyMedia>
                <EmptyTitle>暂无规范</EmptyTitle>
              </EmptyHeader>
            </Empty>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
