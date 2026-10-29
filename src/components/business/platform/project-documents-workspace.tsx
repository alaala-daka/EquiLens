"use client"

import { useEffect, useLayoutEffect, useState, type FormEvent } from "react"
import { BookOpenIcon, FileTextIcon, ScaleIcon } from "lucide-react"
import { AccountEntry } from "@/components/auth/account-entry"
import { DocumentEditor } from "@/components/document-editor"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createProjectDocumentsClient, type ProjectDocument } from "@/lib/business/documents-client"
import { createProjectMaterialsClient, type MaterialSummary, type MaterialUpload } from "@/lib/business/materials-client"
import { downloadDocument, EditorAccessError } from "@/lib/documents/editor-access"
import { errorMessage, type OpenDocument } from "@/lib/documents/types"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import { ProjectSwitcher } from "./project-switcher"
import type { ProjectSummary } from "./projects-client"
import { submitMaterialUpload } from "./project-upload"

const roles = { admin: "项目管理员", editor: "可编辑成员", viewer: "只读成员" }
const states: Record<string, string> = { queued: "排队中", running: "处理中", success: "已完成", succeeded: "已完成", completed: "已完成", failed: "失败", cancelled: "已取消", available: "可读取", partial: "部分覆盖" }

export function ProjectDocumentsWorkspace({ project, registry, accessBlocked = false }: { project: ProjectSummary; registry: UnsavedRegistry; accessBlocked?: boolean }) {
  const [materials, setMaterials] = useState<MaterialSummary[]>([])
  const [documents, setDocuments] = useState<ProjectDocument[]>([])
  const [opened, setOpened] = useState<OpenDocument | null>(null)
  const [preview, setPreview] = useState<MaterialSummary | null>(null)
  const [error, setError] = useState("")
  const [uploadError, setUploadError] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  const [runtime] = useState(() => {
    const life = { active: false, denied: false, paused: false, editable: project.role !== "viewer", controller: new AbortController() }
    const isCurrent = () => life.active && !life.denied && !life.paused
    const onAccessInvalid = () => { life.denied = true; setDenied(true); setError("访问权限已失效，请重新登录或联系项目管理员。") }
    return { pause(value: boolean, editable: boolean) { life.paused = value; life.editable = editable }, start() { life.active = true; life.controller = new AbortController() }, stop() { life.active = false; life.controller.abort() }, signal: () => life.controller.signal, isCurrent,
      docs: createProjectDocumentsClient({ projectId: project.id, isCurrent, canEdit: () => life.editable, onAccessInvalid }),
      materials: createProjectMaterialsClient({ projectId: project.id, isCurrent, onAccessInvalid }) }
  })
  const editable = project.role !== "viewer"
  useLayoutEffect(() => { runtime.pause(accessBlocked, editable) }, [runtime, accessBlocked, editable])
  const signal = runtime.signal
  const current = runtime.isCurrent
  async function refresh() {
    const [materialList, documentList] = await Promise.all([runtime.materials.list(signal()), runtime.docs.list(signal())])
    if (!current()) return
    setMaterials(materialList.materials); setDocuments(documentList.documents)
  }
  useEffect(() => {
    runtime.start()
    let active = true
    const load = async () => {
      try { await refresh() } catch (failure) { if (active && current()) setError(errorMessage(failure)) }
      finally { if (active) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => { if (current() && document.visibilityState === "visible") void refresh().catch(failure => { if (current()) setError(errorMessage(failure)) }) }, 5000)
    return () => { active = false; runtime.stop(); clearInterval(timer) }
    // Only a completed project switch replaces this workspace instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])
  async function act(action: () => Promise<void>) {
    if (busy || !current()) return
    setBusy(true); setError("")
    try { await action() }
    catch (failure) { if (current() && !(failure instanceof EditorAccessError && failure.code === "ABORTED")) setError(errorMessage(failure)) }
    finally { if (current()) setBusy(false) }
  }
  async function uploadMaterial(file: File, metadata: MaterialUpload) {
    return submitMaterialUpload({
      upload: () => runtime.materials.upload(file, metadata, signal()),
      refresh,
      isCurrent: current,
      setBusy,
      setError: setUploadError,
    })
  }
  async function openDocument(id: string) {
    const view = await runtime.docs.view(id, signal())
    if (!view.canEdit || !editable) {
      const material = materials.find(value => value.id === view.document.materialId && value.versionId === view.document.materialVersionId)
      if (current()) setPreview(material ?? null)
      return
    }
    const value = await runtime.docs.access.open(id, { signal: signal() })
    if (current()) setOpened(value)
  }
  const blocked = denied || accessBlocked || !editable
  if (opened) return <><p role="alert" hidden={!blocked}>{error || "访问权限待确认，未保存的修改已保留。"}</p><div inert={blocked}><DocumentEditor key={opened.document.id} opened={opened} access={runtime.docs.access} unsaved={registry}
    blocked={blocked} canEdit={true} projectLabel={project.name} roleLabel={roles[project.role]}
    onBack={() => { setOpened(null); void act(refresh) }} onSaved={saved => setDocuments(values => values.map(value => value.id === saved.document.id ? { ...value, title: saved.document.title, currentVersionId: saved.revision.id } : value))}
    onCopy={saved => { setOpened(saved); void act(refresh) }} /></div></>
  return <main className="flex min-h-svh flex-col">
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-2 border-b px-6 py-2">
      <div className="flex items-center gap-2 text-sm font-medium"><ScaleIcon className="size-5" />衡鉴</div>
      <div className="flex items-center gap-3"><ProjectSwitcher /><AccountEntry /></div>
    </header>
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-6">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {denied ? null : <Tabs defaultValue="documents">
        <TabsList><TabsTrigger value="documents"><FileTextIcon />文档</TabsTrigger><TabsTrigger value="standards"><BookOpenIcon />规范库</TabsTrigger></TabsList>
        <TabsContent value="documents" className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-4"><h1 className="text-lg font-semibold">文档</h1><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void act(refresh)}>刷新</Button>{editable && <UploadMaterial project={project} busy={busy} error={uploadError} onUpload={uploadMaterial} onClearError={() => setUploadError("")} />}</div></div>
          {loading ? <p role="status" className="text-sm">正在读取文档</p> : materials.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>暂无材料</EmptyTitle></EmptyHeader></Empty> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>材料名称</TableHead><TableHead>版本</TableHead><TableHead>解析状态</TableHead><TableHead>覆盖范围</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{materials.map(material => <TableRow key={material.id}>
            <TableCell className="whitespace-normal">{material.title}<Badge variant="outline" className="ml-2">{material.format.toUpperCase()}</Badge></TableCell>
            <TableCell className="whitespace-normal break-all text-xs">{material.versionId}</TableCell>
            <TableCell>{material.parseState ? states[material.parseState] ?? material.parseState : "无解析任务"}</TableCell>
            <TableCell>{material.coverage ? <div className="space-y-1"><span>{states[material.coverage.status] ?? material.coverage.status} · {material.coverage.textLength} 字符</span>{material.coverage.findings.map((finding, i) => <p key={i} className="text-xs text-muted-foreground">{finding.code} · {finding.location}</p>)}</div> : "无解析快照"}</TableCell>
            <TableCell><Button variant="link" disabled={busy} onClick={() => void act(async () => {
              const existing = documents.find(value => value.materialId === material.id && value.materialVersionId === material.versionId)
              if (material.format !== "docx" || !editable) { setPreview(material); return }
              const id = existing?.id ?? (await runtime.docs.importMaterial(material.id, material.versionId, signal())).document.id
              await openDocument(id)
            })}>{editable && material.format === "docx" ? "打开 Word" : "查看材料"}</Button></TableCell>
          </TableRow>)}</TableBody></Table></div>}
          {documents.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>已保存文档</TableHead><TableHead>保存版本</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{documents.map(value => <TableRow key={value.id}><TableCell><Button variant="link" disabled={busy} onClick={() => void act(() => openDocument(value.id))}>{value.title}</Button></TableCell><TableCell className="whitespace-normal break-all text-xs">{value.currentVersionId}</TableCell><TableCell><Button variant="link" disabled={busy} onClick={() => void act(async () => { const blob = await runtime.docs.download(value.id, value.currentVersionId, signal()); if (current()) downloadDocument(blob, value.title) })}>下载 Word</Button></TableCell></TableRow>)}</TableBody></Table></div>}
          {preview && <section aria-label="材料预览" className="space-y-4 rounded-lg border p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-medium">{preview.title}</h2><Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button></div><p className="break-all text-sm">版本：{preview.versionId}</p><Button variant="outline" disabled={busy} onClick={() => void act(async () => {
            const blob = await runtime.materials.content(preview, signal())
            if (!current()) return
            const url = URL.createObjectURL(blob), link = document.createElement("a")
            try { link.href = url; link.download = `${preview.title.replace(/[<>:"/\\|?*]/g, "_")}.${preview.format}`; document.body.append(link); link.click() }
            finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000) }
          })}>下载原件</Button></section>}
        </TabsContent>
        <TabsContent value="standards"><Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><BookOpenIcon /></EmptyMedia><EmptyTitle>暂无规范</EmptyTitle></EmptyHeader></Empty></TabsContent>
      </Tabs>}
    </div>
  </main>
}

function UploadMaterial({ project, busy, error, onUpload, onClearError }: { project: ProjectSummary; busy: boolean; error: string; onUpload(file: File, metadata: MaterialUpload): Promise<boolean>; onClearError(): void }) {
  const [open, setOpen] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) return
    const accepted = await onUpload(file, { title: String(form.get("title")), sourceKind: form.get("sourceKind") === "synthetic" ? "synthetic" : "authorized",
      sourceReference: String(form.get("sourceReference")), purpose: String(form.get("purpose")), retentionUntil: String(form.get("retentionUntil")), processingAuthorized: form.get("processingAuthorized") === "on" })
    if (!accepted) return
    formElement.reset()
    setOpen(false)
  }
  return <Sheet open={open} onOpenChange={value => { setOpen(value); if (value) onClearError() }}><SheetTrigger asChild><Button>上传资料</Button></SheetTrigger><SheetContent className="overflow-auto"><SheetHeader><SheetTitle>上传资料</SheetTitle></SheetHeader><form onSubmit={event => void submit(event)} className="px-4 pb-4">
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <FieldGroup>
    <Field><FieldLabel htmlFor="material-file">文件（DOCX、文字 PDF，最大 20 MiB）</FieldLabel><Input id="material-file" name="file" type="file" accept=".docx,.pdf" required disabled={busy} /></Field>
    <Field><FieldLabel htmlFor="material-title">材料名称</FieldLabel><Input id="material-title" name="title" required maxLength={200} disabled={busy} /></Field>
    <Field><FieldLabel htmlFor="material-source">资料性质</FieldLabel><NativeSelect id="material-source" name="sourceKind" defaultValue={project.source} disabled={busy}><NativeSelectOption value="synthetic">合成材料</NativeSelectOption><NativeSelectOption value="authorized">已授权材料</NativeSelectOption></NativeSelect></Field>
    <Field><FieldLabel htmlFor="material-reference">来源依据</FieldLabel><Input id="material-reference" name="sourceReference" required disabled={busy} /></Field>
    <Field><FieldLabel htmlFor="material-purpose">处理目的</FieldLabel><Input id="material-purpose" name="purpose" defaultValue={project.purpose} required disabled={busy} /></Field>
    <Field><FieldLabel htmlFor="material-retention">保留截止日期</FieldLabel><Input id="material-retention" name="retentionUntil" type="date" defaultValue={project.retentionUntil.slice(0, 10)} max={project.retentionUntil.slice(0, 10)} required disabled={busy} /></Field>
    <Field orientation="horizontal"><input id="material-authorized" name="processingAuthorized" type="checkbox" required disabled={busy} /><FieldLabel htmlFor="material-authorized">确认有权上传并授权上述处理</FieldLabel></Field>
    <Button type="submit" disabled={busy}>{busy ? "正在上传" : "确认上传"}</Button>
  </FieldGroup></form></SheetContent></Sheet>
}
