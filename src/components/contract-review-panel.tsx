"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { ContractReviewReport } from "@/components/contract-review-report"
import { listReviewTasks, readReviewTask, createReviewTask, actOnReviewTask } from "@/lib/contract-reviews/client"
import { taskDisplayStage, taskDisplayState, type ReviewAvailability, type ReviewTask, type SubmitReview } from "@/lib/contract-reviews/types"
import { errorMessage } from "@/lib/documents/types"
import { DocumentSessionError } from "@/lib/documents/client"

export function ContractReviewPanel({ documentId, revisionId, dirty, busy, initialTaskId, onSessionUnavailable }: {
  documentId: string; revisionId: string; dirty: boolean; busy: boolean; initialTaskId?: string
  onSessionUnavailable?: (failure: DocumentSessionError) => void
}) {
  const [configuration, setConfiguration] = useState<ReviewAvailability | null>(null)
  const [tasks, setTasks] = useState<ReviewTask[]>([])
  const [selected, setSelected] = useState(initialTaskId ?? "")
  const [detail, setDetail] = useState<ReviewTask | null>(null)
  // 地域是用户确认的审查条件，不预填，避免默认值被直接提交。
  const [region, setRegion] = useState("")
  const [consentRevision, setConsentRevision] = useState("")
  const consent = consentRevision === revisionId
  const [draftConsent, setDraftConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [retryDialog, setRetryDialog] = useState(false)
  const operation = useRef<{ signature: string; key: string } | null>(null)
  const pending = useRef<AbortController | null>(null)
  const cachedDetail = useRef<{ id: string; updatedAt: string } | null>(null)
  const consentConfiguration = useRef("")

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const value = await listReviewTasks(documentId, controller.signal)
        if (disposed) return
        setTasks(value.tasks)
        setConfiguration(value.configuration)
        if (consentConfiguration.current !== value.configuration.configurationId) {
          consentConfiguration.current = value.configuration.configurationId
          setConsentRevision(""); setDraftConsent(false)
        }
        const id = selected || value.tasks[0]?.id || ""
        if (!selected && id) setSelected(id)
        const listed = value.tasks.find(item => item.id === id)
        if (id && (!cachedDetail.current || cachedDetail.current.id !== id || cachedDetail.current.updatedAt !== listed?.updatedAt)) {
          const task = await readReviewTask(id, controller.signal)
          if (disposed) return
          cachedDetail.current = { id, updatedAt: task.updatedAt }
          setDetail(task)
        }
        setLoading(false)
      } catch (failure) { if (!disposed && !controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 3000) }
    }
    void refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [documentId, selected, reload, onSessionUnavailable])
  useEffect(() => () => { pending.current?.abort() }, [])

  const task = detail?.id === selected ? detail : null
  const active = task?.state === "queued" || task?.state === "running"
  const alreadyRunning = tasks.some(item => item.revisionId === revisionId && ["queued", "running"].includes(item.state))
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || !configuration?.ready || dirty || busy || alreadyRunning || !consent || (configuration.mode === "debug" && !draftConsent)) return
    const controller = new AbortController()
    pending.current = controller; setSubmitting(true); setError("")
    const input: SubmitReview = { documentId, revisionId,
      context: { scene: "auto", role: "专业分包人", region: region.trim() },
      externalProcessingConsent: true, unreviewedMaterialsConsent: draftConsent, configurationId: configuration.configurationId }
    const signature = JSON.stringify(input)
    if (operation.current?.signature !== signature) operation.current = { signature, key: crypto.randomUUID() }
    try {
      const created = await createReviewTask(input, operation.current!.key, controller.signal)
      if (controller.signal.aborted) return
      setDetail(created); setSelected(created.id); cachedDetail.current = null
      setTasks(current => [created, ...current.filter(item => item.id !== created.id)])
      operation.current = null; setConsentRevision(""); setDraftConsent(false); setReload(value => value + 1)
    } catch (failure) { if (!controller.signal.aborted) { setError(errorMessage(failure)); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setSubmitting(false) } }
  }
  async function action(kind: "cancel" | "retry") {
    if (!task || pending.current) return
    const controller = new AbortController()
    pending.current = controller; setSubmitting(true); setError(""); setRetryDialog(false)
    try {
      const updated = await actOnReviewTask(task.id, kind, controller.signal)
      if (controller.signal.aborted) return
      setDetail(updated); cachedDetail.current = null; setReload(value => value + 1)
    } catch (failure) { if (!controller.signal.aborted) { setError(errorMessage(failure)); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setSubmitting(false) } }
  }
  return <section aria-label="合同审查" className="flex flex-col gap-6 p-4">
    <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
      <div className="space-y-1 text-sm"><p className="font-medium">合同审查</p><p className="text-muted-foreground">审查立场：专业分包人</p><p className="break-all text-xs text-muted-foreground">保存版本：{revisionId}</p></div>
      <label className="grid gap-2 text-sm">项目地域<Input value={region} required maxLength={100} placeholder="如：上海" disabled={submitting} onChange={event => { setRegion(event.target.value); setConsentRevision("") }} /></label>
      {configuration?.mode === "debug" && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draftConsent} disabled={submitting} onChange={event => setDraftConsent(event.target.checked)} /><span>我已知悉审查依据尚未核对，结果仅供联调，需人工复核。</span></label>}
      {configuration?.ready && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={submitting} onChange={event => setConsentRevision(event.target.checked ? revisionId : "")} /><span>我确认上述审查条件，并有权将此保存版本发送至 {configuration.providerHost}（{configuration.model}）进行处理。审查记录最多保留 {configuration.retentionDays} 天，原资料先到期时一并清理。</span></label>}
      {dirty && <p role="status" className="text-sm">请先保存更改，再开始审查。</p>}
      {configuration?.error && <p role="alert" className="text-sm text-destructive">{configuration.error}</p>}
      <Button type="submit" disabled={loading || !configuration?.ready || submitting || busy || dirty || alreadyRunning || !region.trim() || !consent || (configuration.mode === "debug" && !draftConsent)}>
        {submitting && <LoaderCircleIcon className="animate-spin" />}开始审查
      </Button>
    </form>
    {error && <div className="flex flex-col gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" disabled={submitting} onClick={() => { setError(""); cachedDetail.current = null; setReload(value => value + 1) }}>重新读取</Button></div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取审查任务</p>}
    {tasks.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">审查记录（{tasks.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-3">{tasks.map(item => <Button type="button" key={item.id} variant={selected === item.id ? "secondary" : "ghost"} className="h-auto justify-start whitespace-normal text-left" onClick={() => { setSelected(item.id); setError("") }}>
        {new Date(item.createdAt).toLocaleString("zh-CN")} · {taskDisplayState(item)}
      </Button>)}</CollapsibleContent>
    </Collapsible>}
    {task && <div className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{taskDisplayState(task)}</Badge><span role="status" className="text-sm">{taskDisplayStage(task)}</span></div>
      <p className="text-sm text-muted-foreground">{new Date(task.createdAt).toLocaleString("zh-CN")} · 保留至 {new Date(task.expiresAt).toLocaleString("zh-CN")}</p>
      {task.revisionId !== revisionId && <p role="note" className="text-sm">此报告对应历史保存版本；当前文档的修改未包含在本次审查中。</p>}
      {active && <p className="text-sm">已读 {task.progress.readParagraphCount} / {task.progress.paragraphCount} 段，已提交 {task.progress.submittedRuleCount} 条检查。</p>}
      {active && task.progress.agentRole === "auditor" && <p className="text-sm">独立复核：{task.progress.auditedRuleCount ?? 0} / {task.result?.findings.length ?? task.progress.submittedRuleCount} 条</p>}
      {task.error && !task.result?.errors.some(item => item.code === task.error?.code) && <p role="alert" className="text-sm text-destructive">{task.error.message}</p>}
      {active && <Button type="button" variant="outline" disabled={submitting} onClick={() => void action("cancel")}>取消审查</Button>}
      {!active && task.state !== "success" && task.stage !== "cancelled" && (!task.result?.sceneSelection || task.result.sceneSelection.status === "matched") && task.attempt < 3 && task.callsUsed < task.maxCalls && <Button type="button" variant="outline" disabled={submitting} onClick={() => setRetryDialog(true)}>继续原任务</Button>}
      {task.result && <ContractReviewReport result={task.result} />}
    </div>}
    <AlertDialog open={retryDialog} onOpenChange={setRetryDialog}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>继续原审查任务？</AlertDialogTitle><AlertDialogDescription>将使用原保存版本、审查条件和模型服务继续处理，可能产生费用。已有结果保留，调用预算和保留期限不会重置。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button type="button" disabled={submitting} onClick={() => void action("retry")}>同意并继续</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
}
