"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ExportRef, ResultValidation } from "@/lib/business/contracts"
import { createProjectPaymentsClient } from "@/lib/business/payments-client"
import { createProjectMaterialsClient, type MaterialSummary } from "@/lib/business/materials-client"
import { ProjectReviewError, type ProjectResultView } from "@/lib/business/reviews-client"
import type { ProjectFactVersion } from "@/lib/facts/types"
import type { LedgerRow, ProjectPaymentDraft } from "@/lib/payments/types"
import { downloadDocument } from "@/lib/documents/editor-access"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"
import { PaymentRowEditor } from "./payment-row-editor"
import { emptyPaymentDraft, newPaymentRow, paymentDraftFromValue, paymentOperation, paymentValue, paymentYuan, replacePaymentRow } from "./payment-form"

export type PaymentsPanelProps = {
  project: ProjectSummary; active: boolean; canEdit: boolean; blocked: boolean
  isCurrent(): boolean; onAccessInvalid(failure: unknown): void; registry: UnsavedRegistry
}

/** Official Table, Card and Field patterns, composed inside the existing project workspace. */
export function ProjectPaymentsPanel({ project, active, canEdit, blocked, isCurrent, onAccessInvalid, registry }: PaymentsPanelProps) {
  const [runtime] = useState(() => {
    const life = { alive: true, blocked, canEdit, isCurrent, onAccessInvalid }
    const current = () => life.alive && !life.blocked && life.isCurrent()
    return {
      client: createProjectPaymentsClient({ projectId: project.id, isCurrent: current, canEdit: () => life.canEdit, onAccessInvalid: failure => life.onAccessInvalid(failure) }),
      materialsClient: createProjectMaterialsClient({ projectId: project.id, isCurrent: current, onAccessInvalid: failure => life.onAccessInvalid(failure) }),
      current,
      configure(next: typeof life) { Object.assign(life, next) },
      start() { life.alive = true }, stop() { life.alive = false },
    }
  })
  useLayoutEffect(() => { runtime.configure({ alive: true, blocked, canEdit, isCurrent, onAccessInvalid }) }, [runtime, blocked, canEdit, isCurrent, onAccessInvalid])
  const current = useCallback(() => runtime.current(), [runtime])
  const { client, materialsClient } = runtime
  const [results, setResults] = useState<ProjectResultView[]>([])
  const [materials, setMaterials] = useState<MaterialSummary[]>([])
  const [facts, setFacts] = useState<ProjectFactVersion[]>([])
  const [selected, setSelected] = useState<ProjectResultView | null>(null)
  const [draft, setDraft] = useState<ProjectPaymentDraft>(emptyPaymentDraft)
  const [base, setBase] = useState<ProjectPaymentDraft>(emptyPaymentDraft)
  const [reason, setReason] = useState("")
  const [comment, setComment] = useState("")
  const [validation, setValidation] = useState<ResultValidation | null>(null)
  const [exports, setExports] = useState<ExportRef[]>([])
  const [editor, setEditor] = useState<LedgerRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  const operation = useRef<{ signature: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const controllers = useRef(new Set<AbortController>())
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)

  useEffect(() => {
    runtime.start()
    const pending = controllers.current
    return () => { runtime.stop(); for (const controller of pending) controller.abort() }
  }, [runtime])
  useEffect(() => {
    if (blocked) for (const controller of controllers.current) controller.abort()
  }, [blocked])

  async function readFacts(signal: AbortSignal) {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/facts`, { signal, credentials: "same-origin", cache: "no-store" })
    if (!current()) throw new ProjectReviewError("ABORTED", "操作已取消。")
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) onAccessInvalid(new ProjectReviewError(response.status === 401 ? "SESSION_INVALID" : "ACCESS_DENIED", "无法读取项目事实。"))
      throw new Error("项目事实读取失败。")
    }
    const value = await response.json() as { facts: ProjectFactVersion[] }
    if (!current()) throw new ProjectReviewError("ABORTED", "操作已取消。")
    return value.facts
  }

  useEffect(() => {
    if (!active || blocked) return
    const controller = new AbortController()
    controllers.current.add(controller)
    void Promise.all([client.listPayments(controller.signal), materialsClient.list(controller.signal), readFacts(controller.signal)]).then(([items, materialList, factList]) => {
      if (!current() || controller.signal.aborted) return
      setResults(items); setMaterials(materialList.materials); setFacts(factList); setLoaded(true)
    }).catch(failure => {
      if (current() && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "款项读取失败。")
    }).finally(() => controllers.current.delete(controller))
    return () => controller.abort()
    // Data refreshes whenever this tab becomes active, including facts saved in the adjoining tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, blocked, client, materialsClient, current])

  function apply(result: ProjectResultView | null) {
    const value = result && paymentValue(result.value)
    const next = value ? paymentDraftFromValue(value) : emptyPaymentDraft()
    setSelected(result); setDraft(next); setBase(next); setValidation(result?.validation ?? null); setReason(""); setComment(""); setEditor(null)
    operation.current = null
  }

  const save = useCallback(async () => {
    if (!canEdit || blocked || !current() || inFlight.current) return false
    if (!reason.trim() || !draft.cutoff || draft.rows.length === 0) { setError("请填写截止日、款项行和保存理由。"); return false }
    const used = new Set(draft.rows.flatMap(row => row.factVersionIds ?? []))
    const refs = [...draft.facts, ...facts.filter(fact => used.has(fact.factVersionId)).map(fact => ({ factId: fact.factId, factVersionId: fact.factVersionId }))]
    const value = { ...draft, facts: [...new Map(refs.filter(fact => used.has(fact.factVersionId)).map(fact => [fact.factVersionId, fact])).values()] }
    const input = { value, reason, ...(selected ? { resultId: selected.resultId, baseVersionId: selected.versionId } : {}) }
    operation.current = paymentOperation(operation.current, JSON.stringify(input), () => crypto.randomUUID())
    const controller = new AbortController(); controllers.current.add(controller)
    inFlight.current = true; setBusy(true); setError("")
    try {
      const result = await client.save({ ...input, operationId: operation.current.id }, controller.signal)
      if (!current() || controller.signal.aborted) return false
      apply(result)
      setExports([])
      setResults(items => [...items.filter(item => item.resultId !== result.resultId), result])
      return true
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : "保存失败。"); return false }
    finally { inFlight.current = false; controllers.current.delete(controller); if (current()) setBusy(false) }
  }, [canEdit, blocked, current, reason, draft, facts, selected, client])

  useEffect(() => {
    if (!dirty || !canEdit || blocked) return
    return registry.register({ id: `payment:${selected?.resultId ?? "new"}`, label: "款项核对表", save, discard: () => { setDraft(base); setEditor(null) } })
  }, [dirty, canEdit, blocked, registry, selected?.resultId, save, base])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current || !current()) return
    const controller = new AbortController(); controllers.current.add(controller)
    inFlight.current = true; setBusy(true); setError("")
    try { await action(controller.signal) }
    catch (failure) { if (current() && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "操作失败。") }
    finally { inFlight.current = false; controllers.current.delete(controller); if (current()) setBusy(false) }
  }

  const savedValue = selected && paymentValue(selected.value)
  return <div hidden={!active} className="space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Card><CardHeader><CardTitle>款项成果</CardTitle></CardHeader><CardContent className="space-y-4">
      {!loaded && <p role="status" className="text-sm text-muted-foreground">正在读取款项成果</p>}
      {loaded && results.length === 0 && <p className="text-sm text-muted-foreground">暂无款项成果</p>}
      {results.length > 0 && <Table><TableHeader><TableRow><TableHead>截止日</TableHead><TableHead>合同</TableHead><TableHead>状态</TableHead><TableHead>保存时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{results.map(result => {
        const value = paymentValue(result.value)
        return <TableRow key={result.resultId}><TableCell>{value?.cutoff}</TableCell><TableCell>{value?.contractId ?? "—"}</TableCell><TableCell>{value?.status === "conditional" ? "有条件测算" : "草案"}</TableCell><TableCell>{new Date(result.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell><Button variant="link" disabled={busy || dirty} onClick={() => void run(async signal => {
          const detail = await client.getResult(result.resultId, undefined, signal)
          const files = await client.listExports(result.resultId, signal)
          if (current()) { apply(detail); setExports(files) }
        })}>打开</Button></TableCell></TableRow>
      })}</TableBody></Table>}
      {canEdit && <Button variant="outline" disabled={busy || dirty || blocked} onClick={() => { apply(null); setExports([]) }}>新建款项表</Button>}
    </CardContent></Card>

    {(canEdit || selected) && <Card><CardHeader><CardTitle>款项核对表</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="payment-cutoff">核对截止日</Label><Input id="payment-cutoff" type="date" value={draft.cutoff} disabled={!canEdit || blocked || busy} onChange={event => setDraft(value => ({ ...value, cutoff: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor="payment-contract">合同标识</Label><Input id="payment-contract" value={draft.contractId ?? ""} disabled={!canEdit || blocked || busy} onChange={event => setDraft(value => { const next = { ...value }; if (event.target.value) next.contractId = event.target.value; else delete next.contractId; return next })} /></div></div>
      {draft.rows.length === 0 ? <p className="text-sm text-muted-foreground">暂无款项行</p> : <Table><TableHeader><TableRow><TableHead>性质</TableHead><TableHead className="text-right">金额（元）</TableHead><TableHead>口径</TableHead><TableHead>到期 / 付款</TableHead><TableHead>确认</TableHead><TableHead>来源</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{draft.rows.map(row => <TableRow key={row.rowId}><TableCell>{row.nature}</TableCell><TableCell className="text-right">{paymentYuan(row.amountFen)}</TableCell><TableCell>{row.basis} / {row.taxBasis}</TableCell><TableCell>{row.eventDate ?? row.dueDate ?? "—"}</TableCell><TableCell><Badge variant={row.confirmation === "已确认" ? "outline" : "secondary"}>{row.confirmation}</Badge></TableCell><TableCell className="whitespace-normal">{row.source?.locator ?? (row.source ? "原文片段" : row.factVersionIds?.length ? "事实版本" : "无来源")}</TableCell><TableCell>{canEdit && <div className="flex gap-2"><Button variant="link" disabled={busy || blocked} onClick={() => setEditor(row)}>编辑</Button><Button variant="ghost" disabled={busy || blocked} onClick={() => setDraft(value => ({ ...value, rows: value.rows.filter(item => item.rowId !== row.rowId) }))}>移除</Button></div>}</TableCell></TableRow>)}</TableBody></Table>}
      {canEdit && <><Button variant="outline" disabled={busy || blocked} onClick={() => setEditor(newPaymentRow(crypto.randomUUID()))}>添加款项行</Button><div className="space-y-2"><Label htmlFor="payment-reason">保存理由</Label><Textarea id="payment-reason" maxLength={500} value={reason} disabled={busy || blocked} onChange={event => setReason(event.target.value)} /></div><div className="flex gap-2"><Button disabled={busy || blocked || !dirty} onClick={() => void save()}>保存款项表</Button>{dirty && <Button variant="outline" disabled={busy} onClick={() => { setDraft(base); setEditor(null) }}>放弃修改</Button>}</div></>}
    </CardContent></Card>}

    {selected && savedValue && <Card><CardHeader><CardTitle>保存版本与计算</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="break-all text-sm">版本：{selected.versionId}</p>
      {savedValue.calculation && <><p className="text-lg font-semibold">已到期未付：{paymentYuan(savedValue.calculation.unpaidFen)} 元</p><p className="text-sm">{savedValue.calculation.formula}</p></>}
      {savedValue.notes.map(note => <p key={note} className="text-sm">{note}</p>)}
      <p className="text-sm">校验：{validation?.status === "valid" ? "通过" : validation?.status === "partial" ? "草案" : "未通过"}；复核：{selected.review?.decision === "approved" ? "已批准" : selected.review?.decision === "rejected" ? "已驳回" : selected.review?.decision === "changes_requested" ? "退回修改" : "待复核"}</p>
      {validation?.issues.map(issue => <p key={issue.code + issue.ref} className="text-sm text-destructive">{issue.message}</p>)}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || blocked} onClick={() => void run(async signal => { const value = await client.validateResult(selected, signal); if (current()) setValidation(value) })}>重新校验</Button>
        {canEdit && <><Button variant="outline" disabled={busy || blocked || dirty || validation?.status === "invalid"} onClick={() => void run(async signal => { const file = await client.createExport(selected, signal); if (current()) setExports(items => [...items, file]) })}>导出 Word</Button><Button variant="outline" disabled={busy || blocked || dirty} onClick={() => void run(async signal => { const result = await client.getResult(selected.resultId, undefined, signal); if (current()) apply(result) })}>读取最新版本</Button></>}
      </div>
      {canEdit && <div className="space-y-2"><Label htmlFor="payment-review-comment">复核意见</Label><Textarea id="payment-review-comment" value={comment} disabled={busy || blocked} onChange={event => setComment(event.target.value)} /><NativeSelect aria-label="复核决定" value="" disabled={busy || blocked || dirty} onChange={event => { const decision = event.target.value as "approved" | "rejected" | "changes_requested"; if (decision) void run(async signal => { const result = await client.reviewResult({ ...selected, decision, comment }, signal); if (current()) { setSelected(result); setValidation(result.validation) } }) }}><NativeSelectOption value="">选择复核决定</NativeSelectOption><NativeSelectOption value="approved" disabled={validation?.status !== "valid"}>批准</NativeSelectOption><NativeSelectOption value="rejected">驳回</NativeSelectOption><NativeSelectOption value="changes_requested">退回修改</NativeSelectOption></NativeSelect></div>}
      {exports.filter(file => file.versionId === selected.versionId).map(file => <Button key={file.exportId} variant="link" disabled={busy || blocked} onClick={() => void run(async signal => { const blob = await client.downloadExport(selected.resultId, file.exportId, signal); if (current()) downloadDocument(blob, "款项核对表.docx") })}>下载 Word · {new Date(file.createdAt).toLocaleString("zh-CN")}</Button>)}
    </CardContent></Card>}
    {editor && canEdit && !blocked && <PaymentRowEditor key={editor.rowId} initial={editor} projectId={project.id} materials={materials} facts={facts} isCurrent={current} onAccessInvalid={onAccessInvalid} onClose={() => setEditor(null)} onChange={row => setDraft(value => ({ ...value, rows: replacePaymentRow(value.rows, row) }))} onSave={row => { setDraft(value => ({ ...value, rows: replacePaymentRow(value.rows, row) })); setEditor(null) }} />}
  </div>
}
