"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ExportRef, ResultValidation } from "@/lib/business/contracts"
import { createProjectEvidenceClient } from "@/lib/business/evidence-client"
import { createProjectMaterialsClient, type MaterialSummary, type SnapshotFragment } from "@/lib/business/materials-client"
import type { ProjectResultView } from "@/lib/business/reviews-client"
import type { EvidenceItem, EvidenceItemDraft, EvidenceReportDraft } from "@/lib/evidence/types"
import type { ProjectFactVersion } from "@/lib/facts/types"
import { downloadDocument } from "@/lib/documents/editor-access"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"
import { VerificationFragmentPicker } from "./verification-fragment-picker"

export type EvidencePanelProps = {
  project: ProjectSummary; active: boolean; canEdit: boolean; blocked: boolean
  isCurrent(): boolean; onAccessInvalid(failure: unknown): void; registry: UnsavedRegistry
}

type TimelineDraft = { id: string; at: string; title: string }
type DisputeDraft = { id: string; title: string; claimAmountFen: string; status: "未确认" | "已确认" | "待核实" }
type GapDraft = { id: string; description: string; status: "开放" | "已补正" }
type ItemEditor = { itemId?: string; baseVersionId: string; reason: string; dirty: boolean; value: EvidenceItemDraft }

const message = (failure: unknown) => failure instanceof Error ? failure.message : "操作失败。"
const emptyDraft = (): EvidenceItemDraft => ({ kind: "材料事实", title: "", confirmation: "未确认", support: "缺少支持", sources: [], conflicts: [], links: [] })

/** 官方 Card/Table/Dialog/Sheet 组合；与款项面板共用未保存登记与只读约定。 */
export function ProjectEvidencePanel({ project, active, canEdit, blocked, isCurrent, onAccessInvalid, registry }: EvidencePanelProps) {
  const [runtime] = useState(() => {
    const life = { alive: true, blocked, canEdit, isCurrent, onAccessInvalid }
    const current = () => life.alive && !life.blocked && life.isCurrent()
    return {
      client: createProjectEvidenceClient({ projectId: project.id, isCurrent: current, canEdit: () => life.canEdit, onAccessInvalid: failure => life.onAccessInvalid(failure) }),
      materials: createProjectMaterialsClient({ projectId: project.id, isCurrent: current, onAccessInvalid: failure => life.onAccessInvalid(failure) }),
      current,
      configure(next: typeof life) { Object.assign(life, next) },
      start() { life.alive = true }, stop() { life.alive = false },
    }
  })
  useLayoutEffect(() => { runtime.configure({ alive: true, blocked, canEdit, isCurrent, onAccessInvalid }); runtime.start() })
  useEffect(() => () => runtime.stop(), [runtime])

  const [items, setItems] = useState<EvidenceItem[]>([])
  const [reports, setReports] = useState<ProjectResultView[]>([])
  const [facts, setFacts] = useState<ProjectFactVersion[]>([])
  const [materials, setMaterials] = useState<MaterialSummary[]>([])
  const [selected, setSelected] = useState<ProjectResultView | null>(null)
  const [validation, setValidation] = useState<ResultValidation | null>(null)
  const [exports, setExports] = useState<ExportRef[]>([])
  const [cutoff, setCutoff] = useState(() => new Date().toISOString().slice(0, 10))
  const [contractId, setContractId] = useState("")
  const [versions, setVersions] = useState<string[]>([])
  const [timeline, setTimeline] = useState<TimelineDraft[]>([])
  const [disputes, setDisputes] = useState<DisputeDraft[]>([])
  const [gaps, setGaps] = useState<GapDraft[]>([])
  const [reason, setReason] = useState("")
  const [editor, setEditor] = useState<ItemEditor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (signal: AbortSignal) => {
    const [nextItems, nextReports] = await Promise.all([runtime.client.listEvidenceItems(signal), runtime.client.listEvidenceReports(signal)])
    if (!runtime.current()) return
    setItems(nextItems); setReports(nextReports); setLoaded(true)
  }, [runtime])

  useEffect(() => {
    if (!active || blocked) return
    const controller = new AbortController()
    void (async () => {
      try { await refresh(controller.signal) }
      catch (failure) { if (runtime.current() && !controller.signal.aborted) setError(message(failure)) }
    })()
    return () => controller.abort()
  }, [active, blocked, refresh, runtime])

  const apply = useCallback((result: ProjectResultView | null) => {
    setSelected(result)
    const value = runtime.client.reportValue(result)
    setValidation(result?.validation ?? null)
    setVersions(value ? value.items.map(item => item.versionId) : [])
    setTimeline(value ? value.timeline.map(event => ({ id: event.id, at: event.at, title: event.title })) : [])
    setDisputes(value ? value.disputes.map(dispute => ({ id: dispute.id, title: dispute.title, claimAmountFen: dispute.claimAmountFen ?? "", status: dispute.status })) : [])
    setGaps(value ? value.gaps.map(gap => ({ id: gap.id, description: gap.description, status: gap.status })) : [])
  }, [runtime])

  async function run<T = void>(action: (signal: AbortSignal) => Promise<T>): Promise<T | false> {
    if (busy || !runtime.current()) return false
    const controller = new AbortController()
    setBusy(true); setError(""); setNotice("")
    try { return await action(controller.signal) }
    catch (failure) { if (runtime.current() && !controller.signal.aborted) setError(message(failure)); return false }
    finally { if (runtime.current()) setBusy(false) }
  }

  async function openEditor(item?: EvidenceItem) {
    if (!canEdit || blocked) return
    await run(async signal => {
      if (!materials.length) setMaterials((await runtime.materials.list(signal)).materials)
      if (!facts.length) setFacts(await runtime.client.listFacts(signal))
      setEditor(item
        ? { itemId: item.itemId, baseVersionId: item.versionId, reason: "", dirty: false, value: {
          contractId: item.contractId, kind: item.kind, title: item.title, occurredAt: item.occurredAt, period: item.period,
          originalValue: item.originalValue, selectedValue: item.selectedValue, unit: item.unit, caliber: item.caliber,
          sources: item.sources, conflicts: item.conflicts, confirmation: item.confirmation, support: item.support,
          links: item.links, pendingLinks: item.pendingLinks, note: item.note } }
        : { baseVersionId: "", reason: "", dirty: false, value: emptyDraft() })
    })
  }

  async function saveItem() {
    if (!editor || !runtime.current()) return false
    if (!editor.value.title.trim() || !editor.reason.trim()) { setError("请填写证据标题和保存理由。"); return false }
    return run(async signal => {
      await runtime.client.saveEvidenceItem({ operationId: crypto.randomUUID(), ...(editor.itemId ? { itemId: editor.itemId } : {}),
        baseVersionId: editor.baseVersionId, reason: editor.reason, value: editor.value }, signal)
      setEditor(null)
      setNotice("证据项已保存为不可变版本。")
      await refresh(signal)
      return true
    })
  }

  useEffect(() => {
    if (!editor?.dirty || !canEdit || blocked) return
    return registry.register({
      id: `evidence:${editor.itemId ?? "new"}`, label: "证据项",
      save: async () => saveItem(), discard: () => setEditor(null),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saveItem closes over the current editor state.
  }, [editor, canEdit, blocked, registry])

  async function saveReport() {
    if (!runtime.current()) return
    if (!reason.trim() || versions.length === 0) { setError("请选择证据项并填写保存理由。"); return }
    await run(async signal => {
      const value: EvidenceReportDraft = { cutoff, ...(contractId ? { contractId } : {}), itemVersionIds: versions,
        timeline: timeline.filter(event => event.at && event.title).map(event => ({ id: event.id, at: event.at, title: event.title, evidenceVersionIds: versions })),
        disputes: disputes.filter(dispute => dispute.title).map(dispute => ({ id: dispute.id, title: dispute.title, ...(dispute.claimAmountFen ? { claimAmountFen: dispute.claimAmountFen } : {}), evidenceVersionIds: versions, status: dispute.status })),
        gaps: gaps.filter(gap => gap.description).map(gap => ({ id: gap.id, description: gap.description, status: gap.status })),
        suggestions: [] }
      const saved = await runtime.client.saveEvidenceReport({ operationId: crypto.randomUUID(), reason, baseVersionId: selected?.versionId ?? "", value,
        ...(selected ? { resultId: selected.resultId } : {}) }, signal)
      apply(saved)
      setExports([])
      setReason("")
      setReports(rows => [...rows.filter(row => row.resultId !== saved.resultId), saved])
      setNotice("证据报告已保存，待复核。")
      await refresh(signal)
    })
  }

  return <div hidden={!active} className="space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>证据项</CardTitle>{canEdit && <Button variant="outline" disabled={busy || blocked} onClick={() => void openEditor()}>新增证据项</Button>}</CardHeader>
      <CardContent>
        {!loaded && <p role="status" className="text-sm text-muted-foreground">正在读取证据项</p>}
        {loaded && items.length === 0 && <p className="text-sm text-muted-foreground">暂无证据项</p>}
        {items.length > 0 && <Table><TableHeader><TableRow><TableHead>标题</TableHead><TableHead>类型</TableHead><TableHead>支持 / 确认</TableHead><TableHead>关联</TableHead><TableHead>版本</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {items.map(item => <TableRow key={item.itemId}>
            <TableCell>{item.title}</TableCell>
            <TableCell>{item.kind}</TableCell>
            <TableCell><Badge variant={item.support === "材料冲突" ? "destructive" : "outline"}>{item.support}</Badge> <span className="text-xs">{item.confirmation}</span></TableCell>
            <TableCell>{item.pendingLinks?.length ? `待关联：${item.pendingLinks.join("、")}` : `${item.links.length} 项`}</TableCell>
            <TableCell>{item.versionId.slice(0, 8)}</TableCell>
            <TableCell>{canEdit && <Button variant="link" disabled={busy || blocked} onClick={() => void openEditor(item)}>编辑</Button>}</TableCell>
          </TableRow>)}
        </TableBody></Table>}
      </CardContent></Card>

    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>证据报告</CardTitle>{canEdit && <Button variant="link" disabled={busy || blocked || items.length === 0} onClick={() => apply(null)}>新建报告</Button>}</CardHeader>
      <CardContent className="space-y-4">
        {reports.length === 0 ? <p className="text-sm text-muted-foreground">暂无证据报告</p> : <Table><TableHeader><TableRow><TableHead>截止日</TableHead><TableHead>状态</TableHead><TableHead>保存时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {reports.map(report => {
            const value = runtime.client.reportValue(report)
            return <TableRow key={report.resultId}><TableCell>{value?.cutoff}</TableCell><TableCell>{value?.status === "incomplete" ? "未完成" : "草稿"}</TableCell>
              <TableCell>{new Date(report.createdAt).toLocaleString("zh-CN")}</TableCell>
              <TableCell><Button variant="link" disabled={busy} onClick={() => void run(async signal => { apply(await runtime.client.getResult(report.resultId, undefined, signal)); setExports(await runtime.client.listExports(report.resultId, signal)) })}>打开</Button></TableCell></TableRow>
          })}
        </TableBody></Table>}

        {(canEdit || selected) && <div className="space-y-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="evidence-cutoff">核对截止日</Label><Input id="evidence-cutoff" type="date" value={cutoff} disabled={!canEdit || busy} onChange={event => setCutoff(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="evidence-contract">合同标识</Label><Input id="evidence-contract" value={contractId} disabled={!canEdit || busy} onChange={event => setContractId(event.target.value)} /></div>
          </div>
          <div className="space-y-2"><p className="text-sm font-medium">引用证据项</p>
            {items.length === 0 ? <p className="text-sm text-muted-foreground">暂无证据项</p> : items.map(item => <label key={item.versionId} className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={!canEdit || busy} checked={versions.includes(item.versionId)} onChange={event => setVersions(previous => event.target.checked ? [...previous, item.versionId] : previous.filter(id => id !== item.versionId))} />
              {item.title}<span className="text-xs text-muted-foreground">{item.support} · {item.versionId.slice(0, 8)}</span>
            </label>)}
          </div>
          <div className="space-y-2"><div className="flex items-center justify-between"><p className="text-sm font-medium">时间线</p>{canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={() => setTimeline(rows => [...rows, { id: crypto.randomUUID(), at: "", title: "" }])}>添加时间线</Button>}</div>
            {timeline.map((event, index) => <div key={event.id} className="flex flex-wrap items-end gap-2">
              <Input aria-label="时间线日期" type="date" value={event.at} disabled={!canEdit || busy} onChange={change => setTimeline(rows => rows.map((row, position) => position === index ? { ...row, at: change.target.value } : row))} />
              <Input aria-label="时间线标题" className="min-w-48 flex-1" value={event.title} disabled={!canEdit || busy} onChange={change => setTimeline(rows => rows.map((row, position) => position === index ? { ...row, title: change.target.value } : row))} />
              {canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTimeline(rows => rows.filter((_, position) => position !== index))}>移除</Button>}
            </div>)}
          </div>
          <div className="space-y-2"><div className="flex items-center justify-between"><p className="text-sm font-medium">争点</p>{canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={() => setDisputes(rows => [...rows, { id: crypto.randomUUID(), title: "", claimAmountFen: "", status: "待核实" }])}>添加争点</Button>}</div>
            {disputes.map((dispute, index) => <div key={dispute.id} className="flex flex-wrap items-end gap-2">
              <Input aria-label="争点标题" className="min-w-48 flex-1" value={dispute.title} disabled={!canEdit || busy} onChange={change => setDisputes(rows => rows.map((row, position) => position === index ? { ...row, title: change.target.value } : row))} />
              <Input aria-label="争议金额（分）" className="w-40" value={dispute.claimAmountFen} disabled={!canEdit || busy} onChange={change => setDisputes(rows => rows.map((row, position) => position === index ? { ...row, claimAmountFen: change.target.value } : row))} />
              {canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDisputes(rows => rows.filter((_, position) => position !== index))}>移除</Button>}
            </div>)}
          </div>
          <div className="space-y-2"><div className="flex items-center justify-between"><p className="text-sm font-medium">缺证项</p>{canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={() => setGaps(rows => [...rows, { id: crypto.randomUUID(), description: "", status: "开放" }])}>添加缺证项</Button>}</div>
            {gaps.map((gap, index) => <div key={gap.id} className="flex flex-wrap items-end gap-2">
              <Input aria-label="缺证项说明" className="min-w-48 flex-1" value={gap.description} disabled={!canEdit || busy} onChange={change => setGaps(rows => rows.map((row, position) => position === index ? { ...row, description: change.target.value } : row))} />
              <NativeSelect aria-label="缺证项状态" value={gap.status} disabled={!canEdit || busy} onChange={change => setGaps(rows => rows.map((row, position) => position === index ? { ...row, status: change.target.value as GapDraft["status"] } : row))}><NativeSelectOption value="开放">开放</NativeSelectOption><NativeSelectOption value="已补正">已补正</NativeSelectOption></NativeSelect>
              {canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setGaps(rows => rows.filter((_, position) => position !== index))}>移除</Button>}
            </div>)}
          </div>
          {canEdit && <><div className="space-y-2"><Label htmlFor="evidence-reason">保存理由</Label><Textarea id="evidence-reason" maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>
            <div className="flex flex-wrap gap-2"><Button disabled={busy || blocked || !reason.trim()} onClick={() => void saveReport()}>{selected ? "保存报告修订" : "生成并保存报告"}</Button>
              {selected && <Button variant="outline" disabled={busy} onClick={() => apply(selected)}>放弃修改</Button>}</div></>}
        </div>}

        {selected && <div className="space-y-4 rounded-lg border p-4">
          <p className="break-all text-sm">版本：{selected.versionId}</p>
          <p className="text-sm">校验：{validation?.status === "valid" ? "通过" : validation?.status === "partial" ? "未完成" : "未通过"}；复核：{selected.review?.decision === "approved" ? "已批准" : selected.review?.decision === "rejected" ? "已驳回" : selected.review?.decision === "changes_requested" ? "退回修改" : "待复核"}</p>
          {validation?.issues.map(issue => <p key={issue.code} className="text-sm text-destructive">{issue.message}</p>)}
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || blocked} onClick={() => void run(async signal => { const value = await runtime.client.validateResult(selected, signal); if (runtime.current()) setValidation(value) })}>重新校验</Button>
            {canEdit && <><Button variant="outline" disabled={busy || blocked || validation?.status === "invalid" || validation?.status === "partial"} onClick={() => void run(async signal => { const file = await runtime.client.createExport(selected, signal); if (runtime.current()) setExports(list => [...list, file]) })}>导出 Word</Button>
              <Button variant="outline" disabled={busy || blocked} onClick={() => void run(async signal => apply(await runtime.client.getResult(selected.resultId, undefined, signal)))}>读取最新版本</Button></>}
          </div>
          {canEdit && <NativeSelect aria-label="复核决定" value="" disabled={busy || blocked} onChange={event => { const decision = event.target.value as "approved" | "rejected" | "changes_requested"; if (decision) void run(async signal => { const result = await runtime.client.reviewResult({ ...selected, decision, comment: "" }, signal); if (runtime.current()) { setSelected(result); setValidation(result.validation) } }) }}>
            <NativeSelectOption value="">选择复核决定</NativeSelectOption>
            <NativeSelectOption value="approved" disabled={validation?.status !== "valid"}>批准</NativeSelectOption>
            <NativeSelectOption value="rejected">驳回</NativeSelectOption>
            <NativeSelectOption value="changes_requested">退回修改</NativeSelectOption>
          </NativeSelect>}
          {exports.filter(file => file.versionId === selected.versionId).map(file => <Button key={file.exportId} variant="link" disabled={busy} onClick={() => void run(async signal => { const blob = await runtime.client.downloadExport(selected.resultId, file.exportId, signal); if (runtime.current()) downloadDocument(blob, "证据整理报告.docx") })}>下载 Word · {new Date(file.createdAt).toLocaleString("zh-CN")}</Button>)}
        </div>}
      </CardContent></Card>

    {editor && canEdit && !blocked && <ItemDialog editor={editor} projectId={project.id} materials={materials} facts={facts} busy={busy}
      loadFragments={async material => (await runtime.materials.snapshot(material.id, material.snapshotId ?? "")).fragments}
      onChange={next => setEditor(next)} onClose={() => setEditor(null)} onSave={() => void saveItem()} />}
  </div>
}

function ItemDialog({ editor, projectId, materials, facts, busy, loadFragments, onChange, onClose, onSave }: {
  editor: ItemEditor; projectId: string; materials: MaterialSummary[]; facts: ProjectFactVersion[]; busy: boolean
  loadFragments(material: MaterialSummary): Promise<SnapshotFragment[]>
  onChange(next: ItemEditor): void; onClose(): void; onSave(): void
}) {
  const [picker, setPicker] = useState<{ open: boolean; fragments: SnapshotFragment[]; loading: boolean; error: string }>({ open: false, fragments: [], loading: false, error: "" })
  const materialId = useRef("")
  const patch = (value: Partial<EvidenceItemDraft>) => onChange({ ...editor, dirty: true, value: { ...editor.value, ...value } })
  const sourceMaterials = materials.filter(material => material.snapshotId)
  async function openPicker(materialKey: string) {
    materialId.current = materialKey
    const material = sourceMaterials.find(item => item.id === materialKey)
    if (!material?.snapshotId) return
    setPicker({ open: true, fragments: [], loading: true, error: "" })
    try {
      const fragments = await loadFragments(material)
      setPicker({ open: true, fragments, loading: false, error: "" })
    } catch (failure) { setPicker({ open: true, fragments: [], loading: false, error: message(failure) }) }
  }
  const toggleFact = (fact: ProjectFactVersion) => {
    const exists = editor.value.links.some(link => link.kind === "fact" && link.factVersionId === fact.factVersionId)
    patch({ links: exists ? editor.value.links.filter(link => !(link.kind === "fact" && link.factVersionId === fact.factVersionId)) : [...editor.value.links, { kind: "fact", factId: fact.factId, factVersionId: fact.factVersionId }] })
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editor.itemId ? "更正证据项" : "新增证据项"}</DialogTitle><DialogDescription>核对标题、来源与支持状态；保存后形成不可变版本。</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="item-title">标题</Label><Input id="item-title" value={editor.value.title} disabled={busy} onChange={event => patch({ title: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="item-kind">类型</Label><NativeSelect id="item-kind" value={editor.value.kind} disabled={busy} onChange={event => patch({ kind: event.target.value as EvidenceItemDraft["kind"] })}>{["材料事实", "人工陈述", "拟约定", "程序计算"].map(kind => <NativeSelectOption key={kind} value={kind}>{kind}</NativeSelectOption>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="item-date">发生日期</Label><Input id="item-date" type="date" value={editor.value.occurredAt ?? ""} disabled={busy} onChange={event => patch({ occurredAt: event.target.value || undefined })} /></div>
          <div className="space-y-2"><Label htmlFor="item-support">支持状态</Label><NativeSelect id="item-support" value={editor.value.support} disabled={busy} onChange={event => patch({ support: event.target.value as EvidenceItemDraft["support"] })}>{["材料支持", "仅人工陈述", "材料冲突", "缺少支持"].map(status => <NativeSelectOption key={status} value={status}>{status}</NativeSelectOption>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="item-confirmation">确认状态</Label><NativeSelect id="item-confirmation" value={editor.value.confirmation} disabled={busy} onChange={event => patch({ confirmation: event.target.value as EvidenceItemDraft["confirmation"] })}>{["未确认", "已确认", "待核实"].map(status => <NativeSelectOption key={status} value={status}>{status}</NativeSelectOption>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="item-source-material">来源材料</Label><NativeSelect id="item-source-material" value="" disabled={busy || sourceMaterials.length === 0} onChange={event => void openPicker(event.target.value)}><NativeSelectOption value="">选择材料并挑选片段</NativeSelectOption>{sourceMaterials.map(material => <NativeSelectOption key={material.id} value={material.id}>{material.title}</NativeSelectOption>)}</NativeSelect></div>
        </div>
        <div className="space-y-2"><p className="text-sm font-medium">支持来源</p>
          {editor.value.sources.length === 0 ? <p className="text-sm text-muted-foreground">尚未选择来源片段</p> : editor.value.sources.map((source, index) => <div key={index} className="space-y-2"><blockquote className="text-sm text-muted-foreground">{source.quote}</blockquote><Button variant="ghost" size="sm" disabled={busy} onClick={() => patch({ sources: editor.value.sources.filter((_, position) => position !== index) })}>移除来源</Button></div>)}
        </div>
        <div className="space-y-2"><p className="text-sm font-medium">关联事实</p>
          {facts.length === 0 ? <p className="text-sm text-muted-foreground">暂无项目事实</p> : facts.map(fact => <label key={fact.factVersionId} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={editor.value.links.some(link => link.kind === "fact" && link.factVersionId === fact.factVersionId)} onChange={() => toggleFact(fact)} />{fact.field} · {fact.selectedValue ?? fact.originalValue ?? "未提供值"}</label>)}
        </div>
        <div className="space-y-2"><Label htmlFor="item-note">说明</Label><Textarea id="item-note" maxLength={2000} value={editor.value.note ?? ""} disabled={busy} onChange={event => patch({ note: event.target.value || undefined })} /></div>
        <div className="space-y-2"><Label htmlFor="item-reason">保存理由</Label><Textarea id="item-reason" maxLength={500} value={editor.reason} disabled={busy} onChange={event => onChange({ ...editor, dirty: true, reason: event.target.value })} /></div>
      </div>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>放弃更改</Button><Button disabled={busy || !editor.value.title.trim() || !editor.reason.trim()} onClick={onSave}>{busy ? "正在保存" : "保存证据项"}</Button></DialogFooter>
    </DialogContent>
    <VerificationFragmentPicker open={picker.open} onOpenChange={open => setPicker(previous => ({ ...previous, open }))} title="选择来源片段" fragments={picker.fragments} loading={picker.loading} error={picker.error}
      onSelect={fragment => {
        const material = sourceMaterials.find(item => item.id === materialId.current)
        if (!material?.snapshotId) return
        patch({ sources: [...editor.value.sources, { projectId, quote: fragment.text, parseSnapshotId: material.snapshotId,
          materialId: material.id, materialVersionId: material.versionId, fragmentId: fragment.id }] })
      }} />
  </Dialog>
}
