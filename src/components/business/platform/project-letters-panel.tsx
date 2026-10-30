"use client"

import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ExportRef, ResultValidation } from "@/lib/business/contracts"
import { createProjectLettersClient } from "@/lib/business/letters-client"
import type { ProjectResultView } from "@/lib/business/reviews-client"
import type { ProjectFactVersion } from "@/lib/facts/types"
import type { PaymentReconciliationValue } from "@/lib/payments/types"
import { downloadDocument } from "@/lib/documents/editor-access"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"

export type LettersPanelProps = {
  project: ProjectSummary; active: boolean; canEdit: boolean; blocked: boolean
  isCurrent(): boolean; onAccessInvalid(failure: unknown): void; registry: UnsavedRegistry
}

type LetterForm = {
  cutoff: string; contractTitle: string; sender: string; recipient: string; demand: string
  plannedDate: string; method: string; address: string
  paymentResultId: string; paymentVersionId: string; paymentSha256: string
  factVersionIds: string[]
  evidenceResultId: string; evidenceVersionId: string; evidenceSha256: string
}

const message = (failure: unknown) => failure instanceof Error ? failure.message : "操作失败。"
const today = () => new Date().toISOString().slice(0, 10)
const emptyForm = (): LetterForm => ({ cutoff: today(), contractTitle: "", sender: "", recipient: "", demand: "", plannedDate: "", method: "", address: "",
  paymentResultId: "", paymentVersionId: "", paymentSha256: "", factVersionIds: [], evidenceResultId: "", evidenceVersionId: "", evidenceSha256: "" })

/** 官方 Card/Table/Field 组合；不提供任何发送入口。 */
export function ProjectLettersPanel({ project, active, canEdit, blocked, isCurrent, onAccessInvalid, registry }: LettersPanelProps) {
  const [runtime] = useState(() => {
    const life = { alive: true, blocked, canEdit, isCurrent, onAccessInvalid }
    const current = () => life.alive && !life.blocked && life.isCurrent()
    return {
      client: createProjectLettersClient({ projectId: project.id, isCurrent: current, canEdit: () => life.canEdit, onAccessInvalid: failure => life.onAccessInvalid(failure) }),
      current,
      configure(next: typeof life) { Object.assign(life, next) },
      start() { life.alive = true }, stop() { life.alive = false },
    }
  })
  useLayoutEffect(() => { runtime.configure({ alive: true, blocked, canEdit, isCurrent, onAccessInvalid }); runtime.start() })
  useEffect(() => () => runtime.stop(), [runtime])

  const [letters, setLetters] = useState<ProjectResultView[]>([])
  const [payments, setPayments] = useState<ProjectResultView[]>([])
  const [candidates, setCandidates] = useState<ProjectResultView[]>([])
  const [facts, setFacts] = useState<ProjectFactVersion[]>([])
  const [selected, setSelected] = useState<ProjectResultView | null>(null)
  const [validation, setValidation] = useState<ResultValidation | null>(null)
  const [exports, setExports] = useState<ExportRef[]>([])
  const [form, setForm] = useState<LetterForm>(emptyForm)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (signal: AbortSignal) => {
    const [nextLetters, allResults, nextFacts] = await Promise.all([runtime.client.listLetters(signal), runtime.client.listResults(signal), runtime.client.listFacts(signal)])
    if (!runtime.current()) return
    setLetters(nextLetters)
    setPayments(allResults.filter(result => result.kind === "payment-reconciliation" && result.validation.status === "valid" && (result.value as PaymentReconciliationValue).status === "conditional"))
    setCandidates(allResults.filter(result => result.kind === "evidence-report"))
    setFacts(nextFacts.filter(fact => fact.confirmation === "已确认"))
    setLoaded(true)
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

  function apply(result: ProjectResultView | null) {
    setSelected(result)
    setValidation(result?.validation ?? null)
    const value = runtime.client.letterValue(result)
    setForm(value ? {
      cutoff: value.cutoff, contractTitle: value.contractTitle, sender: value.sender, recipient: value.recipient, demand: value.demand,
      plannedDate: value.plannedDate, method: value.method, address: value.address,
      paymentResultId: value.payment?.resultId ?? "", paymentVersionId: value.payment?.versionId ?? "", paymentSha256: value.payment?.sha256 ?? "",
      factVersionIds: value.facts.map(fact => fact.factVersionId),
      evidenceResultId: value.evidence?.resultId ?? "", evidenceVersionId: value.evidence?.versionId ?? "", evidenceSha256: value.evidence?.sha256 ?? "",
    } : emptyForm())
    setReason("")
  }

  async function run<T = void>(action: (signal: AbortSignal) => Promise<T>): Promise<T | false> {
    if (busy || !runtime.current()) return false
    const controller = new AbortController()
    setBusy(true); setError(""); setNotice("")
    try { return await action(controller.signal) }
    catch (failure) { if (runtime.current() && !controller.signal.aborted) setError(message(failure)); return false }
    finally { if (runtime.current()) setBusy(false) }
  }

  const patch = (value: Partial<LetterForm>) => setForm(previous => ({ ...previous, ...value }))

  async function save() {
    if (!runtime.current()) return false
    if (!form.paymentResultId || form.factVersionIds.length === 0) { setError("请选择款项成果与至少一条已确认事实。"); return false }
    if (!reason.trim()) { setError("请填写保存理由。"); return false }
    return run(async signal => {
      const saved = await runtime.client.saveLetter({
        operationId: crypto.randomUUID(), reason, baseVersionId: selected?.versionId ?? "", ...(selected ? { resultId: selected.resultId } : {}),
        value: { cutoff: form.cutoff, contractTitle: form.contractTitle, sender: form.sender, recipient: form.recipient, demand: form.demand,
          plannedDate: form.plannedDate, method: form.method, address: form.address,
          payment: { resultId: form.paymentResultId, versionId: form.paymentVersionId, sha256: form.paymentSha256 },
          factVersionIds: form.factVersionIds,
          ...(form.evidenceResultId ? { evidence: { resultId: form.evidenceResultId, versionId: form.evidenceVersionId, sha256: form.evidenceSha256 } } : {}) },
      }, signal)
      apply(saved)
      setExports([])
      setLetters(rows => [...rows.filter(row => row.resultId !== saved.resultId), saved])
      setNotice("催款函已保存，待复核。")
      await refresh(signal)
      return true
    })
  }

  useEffect(() => {
    if (!canEdit || blocked) return
    const id = selected ? `letter:${selected.resultId}` : "letter:new"
    const dirty = selected === null && (form.contractTitle.trim() !== "" || form.sender.trim() !== "" || form.paymentResultId !== "")
    if (!dirty) return
    return registry.register({ id, label: "催款函", save: async () => save(), discard: () => apply(null) })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save closes over the current form state.
  }, [form, selected, canEdit, blocked, registry])

  return <div hidden={!active} className="space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>催款函</CardTitle>{canEdit && <Button variant="outline" disabled={busy || blocked} onClick={() => apply(null)}>新建催款函</Button>}</CardHeader>
      <CardContent>
        {!loaded && <p role="status" className="text-sm text-muted-foreground">正在读取催款函</p>}
        {loaded && letters.length === 0 && <p className="text-sm text-muted-foreground">暂无催款函</p>}
        {letters.length > 0 && <Table><TableHeader><TableRow><TableHead>截止日</TableHead><TableHead>状态</TableHead><TableHead>保存时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {letters.map(letter => {
            const value = runtime.client.letterValue(letter)
            return <TableRow key={letter.resultId}><TableCell>{value?.cutoff}</TableCell>
              <TableCell><Badge variant={value?.status === "ready" ? "outline" : "secondary"}>{value?.status === "ready" ? "可复核草稿" : "草稿"}</Badge></TableCell>
              <TableCell>{new Date(letter.createdAt).toLocaleString("zh-CN")}</TableCell>
              <TableCell><Button variant="link" disabled={busy} onClick={() => void run(async signal => { apply(await runtime.client.getResult(letter.resultId, undefined, signal)); setExports(await runtime.client.listExports(letter.resultId, signal)) })}>打开</Button></TableCell></TableRow>
          })}
        </TableBody></Table>}
      </CardContent></Card>

    {(canEdit || selected) && <Card><CardHeader><CardTitle>催款函内容</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="letter-cutoff">核对截止日</Label><Input id="letter-cutoff" type="date" value={form.cutoff} disabled={!canEdit || busy} onChange={event => patch({ cutoff: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-contract">合同名称或编号</Label><Input id="letter-contract" value={form.contractTitle} disabled={!canEdit || busy} onChange={event => patch({ contractTitle: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-sender">发函主体</Label><Input id="letter-sender" value={form.sender} disabled={!canEdit || busy} onChange={event => patch({ sender: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-recipient">收函主体</Label><Input id="letter-recipient" value={form.recipient} disabled={!canEdit || busy} onChange={event => patch({ recipient: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-planned">拟发送日期</Label><Input id="letter-planned" type="date" value={form.plannedDate} disabled={!canEdit || busy} onChange={event => patch({ plannedDate: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-method">拟用送达方式</Label><Input id="letter-method" value={form.method} disabled={!canEdit || busy} onChange={event => patch({ method: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-address">拟送达地址</Label><Input id="letter-address" value={form.address} disabled={!canEdit || busy} onChange={event => patch({ address: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="letter-payment">款项成果</Label><NativeSelect id="letter-payment" value={form.paymentResultId} disabled={!canEdit || busy} onChange={event => {
          const result = payments.find(item => item.resultId === event.target.value)
          patch({ paymentResultId: result?.resultId ?? "", paymentVersionId: result?.versionId ?? "", paymentSha256: result?.sha256 ?? "" })
        }}><NativeSelectOption value="">选择已核验款项成果</NativeSelectOption>{payments.map(result => <NativeSelectOption key={result.resultId} value={result.resultId}>{`${(result.value as PaymentReconciliationValue).cutoff} · ${(result.value as PaymentReconciliationValue).calculation?.unpaidFen ?? ""} 分`}</NativeSelectOption>)}</NativeSelect>
          {payments.length === 0 && <p className="text-xs text-muted-foreground">暂无可用的已核验款项成果</p>}</div>
      </div>
      <div className="space-y-2"><Label htmlFor="letter-demand">履行要求</Label><Textarea id="letter-demand" maxLength={500} value={form.demand} disabled={!canEdit || busy} onChange={event => patch({ demand: event.target.value })} /></div>
      <div className="space-y-2"><p className="text-sm font-medium">引用已确认事实</p>
        {facts.length === 0 ? <p className="text-sm text-muted-foreground">暂无已确认事实</p> : facts.map(fact => <label key={fact.factVersionId} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit || busy} checked={form.factVersionIds.includes(fact.factVersionId)} onChange={event => patch({ factVersionIds: event.target.checked ? [...form.factVersionIds, fact.factVersionId] : form.factVersionIds.filter(id => id !== fact.factVersionId) })} />{fact.field} · {fact.selectedValue ?? fact.originalValue ?? "未提供值"}</label>)}
      </div>
      <div className="space-y-2"><Label htmlFor="letter-evidence">证据报告（可选）</Label><NativeSelect id="letter-evidence" value={form.evidenceResultId} disabled={!canEdit || busy} onChange={event => {
        const result = candidates.find(item => item.resultId === event.target.value)
        patch({ evidenceResultId: result?.resultId ?? "", evidenceVersionId: result?.versionId ?? "", evidenceSha256: result?.sha256 ?? "" })
      }}><NativeSelectOption value="">不引用证据报告</NativeSelectOption>{candidates.map(result => <NativeSelectOption key={result.resultId} value={result.resultId}>{String((result.value as { cutoff?: string }).cutoff ?? result.resultId)}</NativeSelectOption>)}</NativeSelect></div>
      {canEdit && <><div className="space-y-2"><Label htmlFor="letter-reason">保存理由</Label><Textarea id="letter-reason" maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || blocked || !reason.trim()} onClick={() => void save()}>{selected ? "保存催款函修订" : "生成并保存催款函"}</Button>
          {selected && <Button variant="outline" disabled={busy} onClick={() => apply(selected)}>放弃修改</Button>}</div></>}
    </CardContent></Card>}

    {selected && <Card><CardHeader><CardTitle>草稿正文与状态</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="break-all text-sm">版本：{selected.versionId}</p>
      <p className="text-sm">校验：{validation?.status === "valid" ? "通过" : validation?.status === "partial" ? "草稿" : "未通过"}；复核：{selected.review?.decision === "approved" ? "已批准" : selected.review?.decision === "rejected" ? "已驳回" : selected.review?.decision === "changes_requested" ? "退回修改" : "待复核"}</p>
      {validation?.issues.map(issue => <p key={issue.code} className="text-sm text-destructive">{issue.message}</p>)}
      <div className="space-y-1 rounded-lg border p-4">{runtime.client.letterValue(selected)?.paragraphs.map((paragraph, index) => <p key={index} className="text-sm">{paragraph}</p>)}</div>
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
      {exports.filter(file => file.versionId === selected.versionId).map(file => <Button key={file.exportId} variant="link" disabled={busy} onClick={() => void run(async signal => { const blob = await runtime.client.downloadExport(selected.resultId, file.exportId, signal); if (runtime.current()) downloadDocument(blob, "催款函.docx") })}>下载 Word · {new Date(file.createdAt).toLocaleString("zh-CN")}</Button>)}
    </CardContent></Card>}
  </div>
}
