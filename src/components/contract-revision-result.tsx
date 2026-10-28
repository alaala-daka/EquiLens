"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { downloadRevisedContract, RevisionDownloadError } from "@/lib/contract-reviews/client"
import { DocumentSessionError } from "@/lib/documents/client"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { canExportRevision } from "../../tools/contract-review/src/revision"

export function ContractRevisionResult({ result, taskId, originalReview, onSessionUnavailable, onOpenRevisionTask }: {
  result: ReviewResult; taskId?: string; originalReview: ReactNode; onSessionUnavailable?: (error: DocumentSessionError) => void; onOpenRevisionTask?: (taskId: string) => void
}) {
  const draft = result.collaboration?.revision, audit = result.collaboration?.revisionAudit
  const [downloading, setDownloading] = useState(false), [error, setError] = useState("")
  const [revisionTarget, setRevisionTarget] = useState("")
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [taskId, draft?.id])
  const ready = Boolean(draft?.export && canExportRevision(draft, audit))
  const edits = draft?.edits ?? []
  const unsafe = audit?.checks.filter(item => item.outcome === "存在问题") ?? []
  async function download() {
    if (!taskId || pending.current || !ready) return
    const controller = new AbortController(); pending.current = controller; setDownloading(true); setError(""); setRevisionTarget("")
    try {
      const blob = await downloadRevisedContract(taskId, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob), link = document.createElement("a")
      link.href = url; link.download = draft!.export!.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (failure) { if (!controller.signal.aborted) {
      setError(failure instanceof Error ? failure.message : "修订稿下载失败，请重试。")
      if (failure instanceof RevisionDownloadError && failure.revisionTaskId) setRevisionTarget(failure.revisionTaskId)
      if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure)
    } }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setDownloading(false) } }
  }
  const title = result.sceneCandidates?.find(item => item.id === result.sceneSelection?.sceneId)?.label ?? "合同修订"
  return <div className="flex flex-col gap-6">
    <header className="space-y-2"><h3 className="text-base font-semibold">合同修订建议稿</h3><p className="text-sm text-muted-foreground">{title} · 审查立场：{result.input.context.role ?? "未确认"}</p>
      <p role="status" className="text-sm font-medium">{ready ? `Word 建议稿已保存，正文修改 ${edits.length} 处。` : unsafe.length ? `修改后仍有 ${unsafe.length} 项问题，暂不能导出。` : result.errors.length ? "修订或核对尚未完成，暂不能导出。" : draft?.status === "completed" ? "正文修订已完成，正在核对并保存 Word。" : "正在审查并修订合同。"}</p>
      {ready && <p className="text-sm">AI 核对已完成，仍需人工审核。</p>}
    </header>
    {ready && taskId && <Button type="button" disabled={downloading} onClick={() => void download()}>{downloading ? "正在读取修订稿" : "导出修订建议稿（Word）"}</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {revisionTarget && onOpenRevisionTask && <Button type="button" variant="outline" onClick={() => onOpenRevisionTask(revisionTarget)}>打开修订任务</Button>}
    {result.collaboration?.revisionRepair?.status === "failed" && <p role="status" className="text-sm">自动修正未通过检查，已保留原审查及核对意见。</p>}
    {originalReview}
    {unsafe.length > 0 && <ul className="list-disc space-y-2 pl-4 text-sm">{unsafe.map(item => <li className="break-words" key={item.ruleId}>{item.note}</li>)}</ul>}
    {result.errors.length > 0 && <p role="alert" className="text-sm text-destructive">{result.errors.find(item => !["REVIEW_REVISION_INCOMPLETE", "REVIEW_REVISION_UNSAFE"].includes(item.code))?.message ?? result.errors[0].message}</p>}
    {draft && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">查看修改前后对照</Button></CollapsibleTrigger><CollapsibleContent className="space-y-4 pt-3">{edits.map(edit => <article className="space-y-2 text-sm" key={edit.id}><p className="font-medium">{edit.operation === "replace" ? "替换" : "新增"} · 原第 {edit.paragraphIndex + 1} 段</p><p className="whitespace-pre-wrap break-words">修改前：{edit.before}</p><p className="whitespace-pre-wrap break-words">修改后：{edit.after}</p><p className="text-xs text-muted-foreground">关联检查：{edit.ruleIds.join("、")}</p></article>)}</CollapsibleContent></Collapsible>}
    {draft && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">查看修改后全文</Button></CollapsibleTrigger><CollapsibleContent className="space-y-3 pt-3">{draft.paragraphs.map(item => <p className="whitespace-pre-wrap break-words text-sm" key={item.index}>{item.text}</p>)}</CollapsibleContent></Collapsible>}
    <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">查看 AI 核对详情</Button></CollapsibleTrigger><CollapsibleContent className="space-y-3 pt-3"><p className="text-sm">已核对 {audit?.checks.length ?? 0} / {draft?.decisions.length ?? 0} 项（本次修订范围，未选规则保留原审查结论）。</p>{audit?.checks.map(item => <article className="space-y-2 text-sm" key={item.ruleId}><p>{item.ruleId} · {item.outcome}</p><p className="break-words">{item.note}</p>{item.quote && <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4">第 {item.paragraphIndex + 1} 段：{item.quote}</blockquote>}</article>)}{result.errors.map((item, index) => <p className="break-words text-sm" key={index}>{item.code}：{item.message}</p>)}</CollapsibleContent></Collapsible>
    <p className="text-xs text-muted-foreground">{result.mode === "debug" ? "依据尚未核对，仅供联调。" : ""}修订建议稿需人工审核，待确认事项保留在 Word 中。</p>
  </div>
}
