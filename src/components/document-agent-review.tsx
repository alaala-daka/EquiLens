"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { readDocumentRevisions, reviewDocumentRevision, saveDocumentRevision } from "@/lib/contract-reviews/client"
import type { DocumentAnalysis, DocumentExtraction } from "@/lib/document-agent/types"
import type { DocumentRevision, DocumentReviewDecision } from "@/lib/document-agent/revisions"
import { DocumentSessionError } from "@/lib/documents/client"
import { documentAnalysisMarkdown } from "@/lib/document-agent/report"

const decisions: DocumentReviewDecision[] = ["通过", "驳回", "退回修改"]
const amountKinds = ["计量", "计付基数", "净应付", "付款", "扣项", "未到期", "争议", "材料余额"] as const

export function DocumentAgentReview({ analysis, taskId, documentTitle, documentVersionId, parseSnapshotId, onSessionUnavailable }: {
  analysis: DocumentAnalysis; taskId?: string; documentTitle: string; documentVersionId: string; parseSnapshotId: string
  onSessionUnavailable?: (failure: DocumentSessionError) => void
}) {
  const [versions, setVersions] = useState<{ machine: DocumentRevision; revisions: DocumentRevision[] } | null>(null)
  const [selected, setSelected] = useState("machine")
  const [draft, setDraft] = useState<DocumentExtraction | null>(analysis.extraction)
  const [actor, setActor] = useState(""), [reason, setReason] = useState(""), [note, setNote] = useState("")
  const [decision, setDecision] = useState<DocumentReviewDecision>("通过")
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("")
  const pending = useRef<AbortController | null>(null)
  const editable = analysis.task !== "collection-letter"

  useEffect(() => {
    if (!taskId) return
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller
    readDocumentRevisions(taskId, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setVersions(value)
      const latest = value.revisions.at(-1) ?? value.machine
      setSelected(latest.versionId); setDraft(latest.analysis.extraction)
    }).catch(failure => { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "读取结果版本失败。"); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } })
    return () => controller.abort()
  }, [taskId, onSessionUnavailable])

  if (!taskId || !analysis.extraction) return null
  const all = versions ? [versions.machine, ...versions.revisions] : []
  const current = all.find(item => item.versionId === selected) ?? versions?.machine
  const latest = versions?.revisions.at(-1) ?? versions?.machine

  const choose = (versionId: string) => {
    const value = all.find(item => item.versionId === versionId)
    if (!value) return
    setSelected(versionId); setDraft(value.analysis.extraction); setError(""); setStatus("")
  }
  const patchAmount = (index: number, patch: Record<string, unknown>) => setDraft(value => value ? { ...value,
    amounts: value.amounts.map((item, at) => at === index ? { ...item, ...patch } : item) } : value)
  const patchEvent = (index: number, patch: Record<string, unknown>) => setDraft(value => value ? { ...value,
    events: value.events.map((item, at) => at === index ? { ...item, ...patch } : item) } : value)

  async function save() {
    if (!draft || !taskId || !latest || busy) return
    if (!actor.trim()) { setError("请填写修订人。"); return }
    if (!reason.trim()) { setError("请填写修改理由。"); return }
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller; setBusy(true); setError(""); setStatus("")
    try {
      const saved = await saveDocumentRevision(taskId, { baseVersionId: latest.versionId, extraction: draft, changeReason: reason.trim(), createdBy: actor.trim() }, controller.signal)
      const value = await readDocumentRevisions(taskId, controller.signal)
      setVersions(value); setSelected(saved.versionId); setReason(""); setStatus("已保存人工修订版本。")
    } catch (failure) { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "保存修订失败。"); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function review() {
    if (!taskId || !current || busy) return
    if (!actor.trim()) { setError("请填写复核人。"); return }
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller; setBusy(true); setError(""); setStatus("")
    try {
      await reviewDocumentRevision(taskId, current.versionId, { decision, reviewer: actor.trim(), note: note.trim() }, controller.signal)
      const value = await readDocumentRevisions(taskId, controller.signal)
      setVersions(value); setStatus("已记录复核结论。")
    } catch (failure) { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "提交复核失败。"); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function exportCurrent() {
    if (!current) return
    const reviewed = current.review?.decision === "通过"
    const markdown = documentAnalysisMarkdown(current.analysis, documentTitle, documentVersionId, parseSnapshotId)
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = (documentTitle || "文档").replace(/[\\/:*?"<>|]/g, "_") + "-" + (reviewed ? "已复核版本" : "人工草稿") + ".md"
    link.click(); URL.revokeObjectURL(url)
  }

  return <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">人工修订与复核</summary>
    <div className="mt-4 space-y-4">
      <label className="grid gap-2 text-sm">结果版本<NativeSelect aria-label="结果版本" value={selected} disabled={busy} onChange={event => choose(event.target.value)}>
        {all.map(item => <NativeSelectOption key={item.versionId} value={item.versionId}>{item.isMachine ? "机器结果 v0" : `人工修订 v${item.versionNumber}`}{item.review ? ` · 复核${item.review.decision}` : " · 待复核"}</NativeSelectOption>)}
      </NativeSelect></label>
      {current?.changeReason && <p className="text-xs text-muted-foreground">修改理由：{current.changeReason}</p>}
      <label className="grid gap-2 text-sm">修订人 / 复核人<Input value={actor} maxLength={100} disabled={busy} onChange={event => setActor(event.target.value)} /></label>
      {editable && draft && <>
        {draft.amounts.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">金额条目</p>{draft.amounts.map((item, index) => <div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-3" key={index}>
          <label className="grid gap-1">名称<Input value={item.label} maxLength={80} disabled={busy} onChange={event => patchAmount(index, { label: event.target.value })} /></label>
          <label className="grid gap-1">金额（元）<Input value={item.amountYuan} disabled={busy} onChange={event => patchAmount(index, { amountYuan: event.target.value })} /></label>
          <label className="grid gap-1">原文数字<Input value={item.rawAmount} maxLength={100} disabled={busy} onChange={event => patchAmount(index, { rawAmount: event.target.value })} /></label>
          <label className="grid gap-1">性质<NativeSelect value={item.kind} disabled={busy} onChange={event => patchAmount(index, { kind: event.target.value })}>{amountKinds.map(kind => <NativeSelectOption value={kind} key={kind}>{kind}</NativeSelectOption>)}</NativeSelect></label>
        </div>)}</div>}
        {draft.events.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">证据事件</p>{draft.events.map((item, index) => <div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-2" key={index}>
          <label className="grid gap-1">标题<Input value={item.title} maxLength={80} disabled={busy} onChange={event => patchEvent(index, { title: event.target.value })} /></label>
          <label className="grid gap-1">说明<Input value={item.detail} maxLength={300} disabled={busy} onChange={event => patchEvent(index, { detail: event.target.value })} /></label>
          <label className="grid gap-1">性质<NativeSelect value={item.nature} disabled={busy} onChange={event => patchEvent(index, { nature: event.target.value })}><NativeSelectOption value="材料记载">材料记载</NativeSelectOption><NativeSelectOption value="经办人陈述">经办人陈述</NativeSelectOption><NativeSelectOption value="拟约定">拟约定</NativeSelectOption></NativeSelect></label>
          <label className="grid gap-1">支持状态<NativeSelect value={item.support} disabled={busy} onChange={event => patchEvent(index, { support: event.target.value })}><NativeSelectOption value="材料支持">材料支持</NativeSelectOption><NativeSelectOption value="材料冲突">材料冲突</NativeSelectOption><NativeSelectOption value="支持不足">支持不足</NativeSelectOption></NativeSelect></label>
        </div>)}</div>}
        <label className="grid gap-2 text-sm">需要补充或核对（每行一条）<textarea className="min-h-20 rounded-md border bg-transparent p-2 text-sm" value={draft.gaps.join("\n")} disabled={busy} onChange={event => setDraft(value => value ? { ...value, gaps: event.target.value.split("\n").map(item => item.trim()).filter(Boolean) } : value)} /></label>
        <label className="grid gap-2 text-sm">修改理由<Input value={reason} maxLength={500} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void save()}>保存人工修订版本</Button>
      </>}
      {!editable && <p className="text-sm text-muted-foreground">催款函正文由固定模板生成，当前只支持复核，不支持直接改写正文。</p>}
      <div className="space-y-2 border-t pt-3"><p className="text-sm font-medium">复核当前版本</p>
        <label className="grid gap-2 text-sm">结论<NativeSelect value={decision} disabled={busy} onChange={event => setDecision(event.target.value as DocumentReviewDecision)}>{decisions.map(item => <NativeSelectOption value={item} key={item}>{item}</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm">复核意见<Input value={note} maxLength={1000} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
        <Button type="button" disabled={busy} onClick={() => void review()}>提交复核</Button>
        {current?.review && <p className="text-sm">最近复核：{current.review.decision} · {current.review.reviewer} · {new Date(current.review.createdAt).toLocaleString("zh-CN")}{current.review.note ? "：" + current.review.note : ""}</p>}
      {current && <Button type="button" variant="outline" disabled={busy} onClick={exportCurrent}>{current.review?.decision === "通过" ? "导出已复核版本（Markdown）" : "导出当前版本草稿（Markdown）"}</Button>}
      </div>
      {status && <p role="status" className="text-sm">{status}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </details>
}
