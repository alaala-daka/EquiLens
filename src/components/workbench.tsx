"use client"

import { useEffect, useRef, useState } from "react"
import { BookOpenIcon, FileTextIcon, PlusIcon, ScaleIcon, UploadIcon, LoaderCircleIcon } from "lucide-react"

import { DocumentEditor } from "@/components/document-editor"
import { ContractReviewHistory } from "@/components/contract-review-history"
import { blankDocx } from "@/lib/documents/docx"
import { createDocument as persistDocument, listDocuments, openDocument } from "@/lib/documents/client"
import { errorMessage, type DocumentRecord, type OpenDocument } from "@/lib/documents/types"
import { validateDocx } from "@/lib/documents/validate"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function Workbench() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [opened, setOpened] = useState<OpenDocument | null>(null)
  const [reviewTaskId, setReviewTaskId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController | null>(null)
  const [activeTab, setActiveTab] = useState("documents")
  useEffect(() => {
    let disposed = false
    void listDocuments().then(values => { if (!disposed) setDocuments(values) }).catch(failure => { if (!disposed) setError(errorMessage(failure)) }).finally(() => { if (!disposed) setLoading(false) })
    const refresh = () => { void listDocuments().then(values => { if (!disposed) setDocuments(values) }).catch(failure => { if (!disposed) setError(errorMessage(failure)) }) }
    window.addEventListener("focus", refresh)
    return () => { disposed = true; operation.current?.abort(); window.removeEventListener("focus", refresh) }
  }, [])

  function recordSaved(saved: OpenDocument) {
    setDocuments(current => [saved.document, ...current.filter(item => item.id !== saved.document.id)])
  }

  async function createOrImport(file?: File) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError("")
    try {
      if (file && !/\.docx$/i.test(file.name)) throw new Error("请选择 .docx 格式的 Word 文档。")
      const blob = file ?? blankDocx()
      await validateDocx(blob, controller.signal)
      controller.signal.throwIfAborted()
      const result = await persistDocument(blob, file ? file.name.replace(/\.docx$/i, "") : "未命名文档", file ? "imported" : "authored", file?.name)
      if (controller.signal.aborted) return
      recordSaved(result)
      setReviewTaskId(undefined)
      setOpened(result)
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure))
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false) }
    }
  }

  async function open(id: string, taskId?: string) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError("")
    try {
      const result = await openDocument(id)
      await validateDocx(result.revision.blob, controller.signal)
      controller.signal.throwIfAborted()
      setReviewTaskId(taskId)
      setOpened(result)
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)) }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false) } }
  }

  if (opened) {
    return <DocumentEditor key={opened.document.id} opened={opened} onSaved={recordSaved} onBack={() => setOpened(null)} onCopy={setOpened} initialReviewTaskId={reviewTaskId} />
  }

  return (
    <main className="flex min-h-svh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ScaleIcon className="size-5" />
          衡鉴 <span className="font-normal text-muted-foreground">EquiLens</span>
        </div>
        <Button variant="link" asChild><a href="/source" target="_blank" rel="noreferrer">源代码</a></Button>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-6">
        <input ref={fileInput} type="file" accept=".docx" aria-label="选择 Word 文件" className="hidden" disabled={loading || busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void createOrImport(file) }} />
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
        {busy && <div role="status" className="mb-4 flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在打开文档<Button variant="ghost" size="sm" onClick={() => { operation.current?.abort(); operation.current = null; setBusy(false) }}>取消</Button></div>}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 gap-6">
          <TabsList>
            <TabsTrigger value="documents"><FileTextIcon />文档</TabsTrigger>
            <TabsTrigger value="standards"><BookOpenIcon />规范库</TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-lg font-semibold">文档</h1>
              <div className="flex gap-2">
                <Button variant="outline" disabled={loading || busy} onClick={() => fileInput.current?.click()}><UploadIcon />导入 Word</Button>
                <Button disabled={loading || busy} onClick={() => void createOrImport()}><PlusIcon />新建文档</Button>
              </div>
            </div>
            {loading ? <div role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取文档</div> : documents.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>暂无文档</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" disabled={busy} onClick={() => void createOrImport()}><PlusIcon />创建文档</Button>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>文档名称</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((document) => (
                      <TableRow key={document.id}>
                        <TableCell>
                          <Button variant="link" disabled={busy} className="h-auto max-w-full justify-start px-0" onClick={() => void open(document.id)}>
                            <FileTextIcon /><span className="truncate">{document.title.trim() || "未命名文档"}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <ContractReviewHistory busy={busy || loading} onOpen={(documentId, taskId) => void open(documentId, taskId)} />
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
