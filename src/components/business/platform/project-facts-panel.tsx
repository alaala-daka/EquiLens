"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ProjectSummary } from "./projects-client"
import { createProjectFactsClient, type FactCandidate, type FactCandidatesValue } from "@/lib/business/facts-client"
import { createProjectMaterialsClient, type SnapshotFragment } from "@/lib/business/materials-client"
import type { ProjectReviewMaterial, ProjectTaskView } from "@/lib/business/reviews-client"
import { ProjectReviewError } from "@/lib/business/reviews-client"
import type { ProjectFactDraft, ProjectFactVersion, SaveProjectFact } from "@/lib/facts/types"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import { candidateFactDraft, emptyFactDraft, savedFactDraft } from "./fact-draft"
import { VerificationFragmentPicker } from "./verification-fragment-picker"

export type FactsPanelProps = { project: ProjectSummary; active: boolean; canEdit: boolean; blocked: boolean; isCurrent(): boolean; onAccessInvalid(failure: unknown): void; registry: UnsavedRegistry }
type Editor = SaveProjectFact & { dirty: boolean }
type CandidateResult = { resultId: string; versionId: string; value: FactCandidatesValue }
const message = (failure: unknown) => failure instanceof Error ? failure.message : "操作失败，请重试。"
const terminal = (task: ProjectTaskView) => !["queued", "running"].includes(task.state)
const taskLabel: Record<string, string> = { queued: "排队中", running: "处理中", success: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" }

/** Official Table + Dialog patterns; source selection reuses the existing snapshot picker. */
export function ProjectFactsPanel(props: FactsPanelProps) {
  const { project, active, canEdit, blocked, registry } = props
  const [runtime] = useState(() => {
    const life = { alive: true, blocked, canEdit }
    const current = () => life.alive && props.isCurrent() && !life.blocked
    const client = createProjectFactsClient({ projectId: project.id, isCurrent: current, canEdit: () => life.canEdit, onAccessInvalid: props.onAccessInvalid })
    const materialsClient = createProjectMaterialsClient({ projectId: project.id, isCurrent: current, onAccessInvalid: props.onAccessInvalid })
    return { client, materialsClient, current, configure(next: { blocked: boolean; canEdit: boolean }) { Object.assign(life, next) }, start() { life.alive = true }, stop() { life.alive = false } }
  })
  const { client, materialsClient } = runtime
  const current = useCallback(() => runtime.current(), [runtime])
  useEffect(() => { runtime.configure({ blocked, canEdit }) }, [runtime, blocked, canEdit])
  useEffect(() => { runtime.start(); return () => runtime.stop() }, [runtime])
  const [facts, setFacts] = useState<ProjectFactVersion[]>([])
  const [materials, setMaterials] = useState<ProjectReviewMaterial[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [tasks, setTasks] = useState<ProjectTaskView[]>([])
  const [results, setResults] = useState<CandidateResult[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef(editor)
  useEffect(() => { editorRef.current = editor }, [editor])
  const [history, setHistory] = useState<ProjectFactVersion[] | null>(null)
  const [picker, setPicker] = useState<"sources" | "conflicts" | null>(null)
  const [sourceMaterial, setSourceMaterial] = useState("")
  const [fragments, setFragments] = useState<SnapshotFragment[]>([])
  const [fragmentLoading, setFragmentLoading] = useState(false)
  const [fragmentError, setFragmentError] = useState("")
  const pendingPrepare = useRef<{ signature: string; key: string } | null>(null)

  const reload = useCallback(async (signal?: AbortSignal) => {
    const [factRows, materialRows, taskRows, candidateRows] = await Promise.all([client.list(signal), client.listMaterials(signal), client.listTasks(signal), client.listCandidates(signal)])
    if (!current() || signal?.aborted) return
    setFacts(factRows); setMaterials(materialRows); setTasks(taskRows); setResults(candidateRows)
  }, [client, current])
  useEffect(() => {
    if (!active || blocked) return
    const controller = new AbortController()
    void (async () => {
      setLoading(true)
      try { await reload(controller.signal); if (current() && !controller.signal.aborted) setError("") }
      catch (failure) { if (current() && !controller.signal.aborted) setError(message(failure)) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [active, blocked, current, reload])
  useEffect(() => {
    if (!active || blocked || !tasks.some(task => !terminal(task))) return
    const controller = new AbortController()
    const timer = setTimeout(() => { void reload(controller.signal).catch(failure => { if (current() && !controller.signal.aborted) setError(message(failure)) }) }, 2000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [active, blocked, current, reload, tasks])
  useEffect(() => {
    const material = materials.find(item => item.id === sourceMaterial)
    if (!picker || !material?.snapshotId) return
    const controller = new AbortController()
    void (async () => {
      setFragmentLoading(true); setFragmentError(""); setFragments([])
      try { const value = await materialsClient.snapshot(material.id, material.snapshotId!, controller.signal); if (!controller.signal.aborted) setFragments(value.fragments) }
      catch (failure) { if (!controller.signal.aborted) setFragmentError(message(failure)) }
      finally { if (!controller.signal.aborted) setFragmentLoading(false) }
    })()
    return () => controller.abort()
  }, [picker, sourceMaterial, materials, materialsClient])

  const save = useCallback(async (): Promise<boolean> => {
    const draft = editorRef.current
    if (!draft || !current() || !canEdit) return false
    setBusy(true); setError("")
    try {
      const { dirty: _dirty, ...input } = draft
      void _dirty
      const saved = await client.save(input)
      if (!current()) return false
      setFacts(rows => [...rows.filter(row => row.factId !== saved.factId), saved].sort((a, b) => a.field.localeCompare(b.field)))
      setEditor(null)
      return true
    } catch (failure) { if (current()) setError(message(failure)); return false } finally { if (current()) setBusy(false) }
  }, [client, current, canEdit])
  useEffect(() => {
    if (!editor?.dirty) return
    return registry.register({ id: `fact:${editor.factId ?? "new"}`, label: "项目事实", save, discard: () => setEditor(null) })
  }, [editor, registry, save])
  const patch = (value: Partial<ProjectFactDraft>) => setEditor(previous => previous ? { ...previous, dirty: true, value: { ...previous.value, ...value } } : null)
  const edit = (fact?: ProjectFactVersion) => { setError(""); setEditor({ operationId: crypto.randomUUID(), ...(fact ? { factId: fact.factId } : {}), baseVersionId: fact?.factVersionId ?? "", reason: "", value: fact ? savedFactDraft(fact) : emptyFactDraft(), dirty: false }) }
  const confirm = (candidate: FactCandidate, value: FactCandidatesValue) => { setError(""); setEditor({ operationId: crypto.randomUUID(), baseVersionId: "", reason: "确认材料事实候选", value: candidateFactDraft(project.id, candidate, value), dirty: true }) }
  async function prepare() {
    setBusy(true); setError("")
    try {
      const refs = materials.filter(material => selected.includes(material.id)).map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 }))
      const signature = JSON.stringify(refs)
      if (!pendingPrepare.current || pendingPrepare.current.signature !== signature) pendingPrepare.current = { signature, key: crypto.randomUUID() }
      const response = await client.prepare(refs, pendingPrepare.current.key)
      if (!current()) return
      setTasks(previous => [response.task, ...previous.filter(task => task.id !== response.task.id)])
      pendingPrepare.current = null; setConsent(false)
    } catch (failure) { if (current() && !(failure instanceof ProjectReviewError && failure.code === "ABORTED")) setError(message(failure)) } finally { if (current()) setBusy(false) }
  }
  function pickFragment(fragment: SnapshotFragment) {
    const material = materials.find(item => item.id === sourceMaterial)
    if (!editor || !picker || !material?.snapshotId) return
    const source = { projectId: project.id, materialId: material.id, materialVersionId: material.versionId, parseSnapshotId: material.snapshotId, fragmentId: fragment.id, quote: fragment.text }
    patch({ [picker]: [...editor.value[picker], source], ...(picker === "conflicts" ? { support: "材料冲突" as const } : {}) })
  }
  const readOnly = !canEdit || blocked
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取项目事实</p>}
    {canEdit && <Card><CardHeader><CardTitle>事实准备</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="space-y-2">{materials.filter(material => material.snapshotId && material.coverage?.status !== "failed").map(material => <label key={material.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(material.id)} disabled={readOnly || busy || (!selected.includes(material.id) && selected.length >= 5)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, material.id] : previous.filter(id => id !== material.id)); setConsent(false) }} />{material.title}<Badge variant="outline">{material.coverage?.status === "partial" ? "部分可用" : "可用"}</Badge></label>)}{!materials.some(material => material.snapshotId) && <p className="text-sm text-muted-foreground">暂无已解析材料</p>}</div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={readOnly || busy} onChange={event => setConsent(event.target.checked)} />同意将所选材料版本发送给模型服务提取事实候选</label>
      <Button disabled={readOnly || busy || selected.length === 0 || !consent} onClick={() => void prepare()}>准备事实</Button>
    </CardContent></Card>}
    {tasks.length > 0 && <Card><CardHeader><CardTitle>处理记录</CardTitle></CardHeader><CardContent className="space-y-2">{tasks.map(task => <div key={task.id} className="text-sm"><Badge variant="outline">{taskLabel[task.state]}</Badge><span className="ml-2">{new Date(task.createdAt).toLocaleString()}</span>{task.error && <p role="alert" className="text-destructive">{task.error.message}</p>}</div>)}</CardContent></Card>}
    {results.map(result => <Card key={result.versionId}><CardHeader><CardTitle>候选事实</CardTitle></CardHeader><CardContent className="space-y-3">
      {result.value.warnings.map(warning => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
      {result.value.candidates.map(candidate => <div key={candidate.candidateId} className="space-y-2 rounded-lg border p-3"><p className="text-sm font-medium">{candidate.field}：{candidate.originalValue ?? "未提供值"}</p><p className="text-xs text-muted-foreground">{candidate.subject} · {candidate.nature}</p>{candidate.sources.map((source, index) => <blockquote key={index} className="text-sm text-muted-foreground">{source.quote}</blockquote>)}{canEdit && <Button variant="outline" size="sm" disabled={readOnly || busy || !!editor} onClick={() => confirm(candidate, result.value)}>确认或更正</Button>}</div>)}
      {result.value.rejected.length > 0 && <details><summary className="text-sm">拒绝项（{result.value.rejected.length}）</summary>{result.value.rejected.map((item, index) => <p key={index} className="text-sm">{item.reason}{item.quote ? `：${item.quote}` : ""}</p>)}</details>}
    </CardContent></Card>)}
    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>项目事实</CardTitle>{canEdit && <Button variant="outline" disabled={readOnly || busy || !!editor} onClick={() => edit()}>新增事实</Button>}</CardHeader><CardContent>
      {facts.length === 0 ? <p className="text-sm text-muted-foreground">暂无项目事实</p> : <Table><TableHeader><TableRow><TableHead>字段 / 主体</TableHead><TableHead>选用值</TableHead><TableHead>状态</TableHead><TableHead>版本</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{facts.map(fact => <TableRow key={fact.factId}><TableCell>{fact.field}<p className="text-xs text-muted-foreground">{fact.subject}</p></TableCell><TableCell>{fact.selectedValue ?? fact.originalValue ?? "未提供值"}</TableCell><TableCell><Badge variant={fact.evidenceStatus === "材料冲突" || fact.confirmation === "待核实" ? "destructive" : "outline"}>{fact.evidenceStatus}</Badge><p className="text-xs">{fact.confirmation} · {fact.nature}</p></TableCell><TableCell>{fact.version}</TableCell><TableCell><div className="flex gap-2">{canEdit && <Button variant="outline" size="sm" disabled={readOnly || busy || !!editor} onClick={() => edit(fact)}>更正</Button>}<Button variant="ghost" size="sm" disabled={blocked} onClick={() => { void client.history(fact.factId).then(setHistory).catch(failure => setError(message(failure))) }}>历史</Button></div></TableCell></TableRow>)}</TableBody></Table>}
    </CardContent></Card>
    <Dialog open={!!editor} onOpenChange={open => { if (!open && !editor?.dirty && !busy) setEditor(null) }}><DialogContent className="max-h-screen overflow-y-auto"><DialogHeader><DialogTitle>{editor?.factId ? "更正事实" : "确认事实"}</DialogTitle><DialogDescription>核对事实值、来源及确认状态。</DialogDescription></DialogHeader>{editor && <div className="space-y-4">
      {([ ["field", "字段"], ["contractId", "合同标识"], ["subject", "主体"], ["originalValue", "原值"], ["selectedValue", "选用值"], ["unit", "单位"], ["caliber", "统计口径"] ] as const).map(([key, label]) => <label key={key} className="grid gap-2 text-sm">{label}<Input value={editor.value[key] ?? ""} disabled={readOnly || busy} readOnly={key === "originalValue" && !!editor.factId} onChange={event => patch({ [key]: event.target.value || undefined })} /></label>)}
      {([ ["occurredAt", "发生日期"], ["periodStart", "期间起始"], ["periodEnd", "期间截止"] ] as const).map(([key, label]) => <label key={key} className="grid gap-2 text-sm">{label}<Input type="date" value={editor.value[key] ?? ""} disabled={readOnly || busy} onChange={event => patch({ [key]: event.target.value || undefined })} /></label>)}
      <label className="grid gap-2 text-sm">性质<NativeSelect value={editor.value.nature} disabled={readOnly || busy} onChange={event => patch({ nature: event.target.value as ProjectFactDraft["nature"] })}>{["材料记载", "人工陈述", "拟约定"].map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></label>
      <label className="grid gap-2 text-sm">确认状态<NativeSelect value={editor.value.confirmation} disabled={readOnly || busy} onChange={event => patch({ confirmation: event.target.value as ProjectFactDraft["confirmation"] })}>{["未确认", "已确认", "待核实"].map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></label>
      <label className="grid gap-2 text-sm">支持状态<NativeSelect value={editor.value.support} disabled={readOnly || busy} onChange={event => patch({ support: event.target.value as ProjectFactDraft["support"] })}>{["材料支持", "仅人工陈述", "材料冲突", "缺少支持"].map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></label>
      <label className="grid gap-2 text-sm">来源材料<NativeSelect value={sourceMaterial} disabled={readOnly || busy} onChange={event => setSourceMaterial(event.target.value)}><NativeSelectOption value="">选择材料</NativeSelectOption>{materials.filter(material => material.snapshotId).map(material => <NativeSelectOption key={material.id} value={material.id}>{material.title}</NativeSelectOption>)}</NativeSelect></label>
      {(["sources", "conflicts"] as const).map(kind => <div key={kind} className="space-y-2"><div className="flex items-center justify-between"><p className="text-sm font-medium">{kind === "sources" ? "支持来源" : "冲突来源"}</p><Button variant="outline" size="sm" disabled={readOnly || busy || !sourceMaterial} onClick={() => setPicker(kind)}>添加片段</Button></div>{editor.value[kind].map((source, index) => <div key={index} className="space-y-2"><Textarea aria-label={kind === "sources" ? "支持引文" : "冲突引文"} value={source.quote} disabled={readOnly || busy} onChange={event => patch({ [kind]: editor.value[kind].map((item, position) => position === index ? { ...item, quote: event.target.value } : item) })} /><Button variant="ghost" size="sm" disabled={readOnly || busy} onClick={() => patch({ [kind]: editor.value[kind].filter((_, position) => position !== index) })}>移除引文</Button></div>)}</div>)}
      <label className="grid gap-2 text-sm">保存理由<Textarea value={editor.reason} required maxLength={500} disabled={readOnly || busy} onChange={event => setEditor({ ...editor, dirty: true, reason: event.target.value })} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>放弃更改</Button><Button disabled={readOnly || busy || !editor?.value.field || !editor.reason.trim()} onClick={() => void save()}>{busy ? "正在保存" : "保存事实"}</Button></DialogFooter></DialogContent></Dialog>
    <VerificationFragmentPicker open={!!picker} onOpenChange={open => { if (!open) setPicker(null) }} title="选择事实来源" fragments={fragments} loading={fragmentLoading} error={fragmentError} onSelect={pickFragment} />
    <Dialog open={history !== null} onOpenChange={open => { if (!open) setHistory(null) }}><DialogContent className="max-h-screen overflow-y-auto"><DialogHeader><DialogTitle>事实历史</DialogTitle><DialogDescription>{history?.[0]?.field}</DialogDescription></DialogHeader>{history?.map(fact => <article key={fact.factVersionId} className="space-y-2 rounded-lg border p-3"><p className="text-sm font-medium">版本 {fact.version} · {fact.selectedValue ?? fact.originalValue}</p><p className="text-xs text-muted-foreground">{fact.createdAt} · {fact.createdBy}</p><p className="text-sm">{fact.reason}</p><Badge variant="outline">{fact.evidenceStatus} · {fact.confirmation}</Badge>{[...fact.sources, ...fact.conflicts].map((source, index) => <blockquote key={index} className="text-sm">{source.quote}</blockquote>)}</article>)}</DialogContent></Dialog>
  </div>
}
