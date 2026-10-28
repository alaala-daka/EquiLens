"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { ContractReviewReport } from "@/components/contract-review-report"
import { DocumentAgentReport } from "@/components/document-agent-report"
import { documentTaskLabels, type LetterPlan } from "@/lib/document-agent/types"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { listReviewTasks, readReviewTask, createReviewTask, actOnReviewTask } from "@/lib/contract-reviews/client"
import { taskDisplayStage, taskDisplayState, taskStateHint, type ReviewAvailability, type ReviewTask, type SubmitReview } from "@/lib/contract-reviews/types"
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
  const [generateRevision, setGenerateRevision] = useState(false)
  const [kind, setKind] = useState<keyof typeof documentTaskLabels>("contract-review")
  const [cutoff, setCutoff] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()))
  const [letterPlan, setLetterPlan] = useState<LetterPlan>(() => ({ sender: "", recipient: "", contractTitle: "", demand: "于收到本函后及时核对并支付已到期款项", plannedDate: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()), method: "", address: "" }))
  const [paymentTaskId, setPaymentTaskId] = useState("")
  const [evidenceTaskId, setEvidenceTaskId] = useState("")
  const changePlan = (field: keyof LetterPlan, value: string) => { setLetterPlan(current => ({ ...current, [field]: value })); setConsentRevision("") }
  const business = kind !== "contract-review"
  const ready = business ? configuration?.documentTasks?.ready : configuration?.ready
  const configurationId = business ? configuration?.documentTasks?.configurationId : configuration?.configurationId
  const needsDraftConsent = !business && configuration?.mode === "debug"
  const tokenLimit = business ? configuration?.documentTasks?.maxKnownTokens : configuration?.maxKnownTokens
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [retryDialog, setRetryDialog] = useState(false)
  const operation = useRef<{ signature: string; key: string } | null>(null)
  const pending = useRef<AbortController | null>(null)
  const cachedDetail = useRef<{ id: string; updatedAt: string } | null>(null)
  const consentConfiguration = useRef("")
  const initialSelection = useRef(initialTaskId ?? "")

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let pollingActive = false
    async function refresh() {
      if (disposed || inFlight) return
      inFlight = true
      try {
        const value = await listReviewTasks(documentId, controller.signal)
        if (disposed) return
        setTasks(value.tasks)
        setConfiguration(value.configuration)
        pollingActive = value.tasks.some(item => item.state === "queued" || item.state === "running")
        const consentVersion = value.configuration.configurationId + ":" + (value.configuration.documentTasks?.configurationId ?? "")
        if (consentConfiguration.current !== consentVersion) {
          consentConfiguration.current = consentVersion
          setConsentRevision(""); setDraftConsent(false)
        }
        const id = selected || value.tasks.find(item => (item.kind ?? "contract-review") === kind)?.id || ""
        if (!selected && id) setSelected(id)
        const listed = value.tasks.find(item => item.id === id)
        if (id && (!cachedDetail.current || cachedDetail.current.id !== id || cachedDetail.current.updatedAt !== listed?.updatedAt)) {
          const task = await readReviewTask(id, controller.signal)
          if (disposed) return
          cachedDetail.current = { id, updatedAt: task.updatedAt }
          setDetail(task)
          if (initialSelection.current === id) { setKind(task.kind ?? "contract-review"); if (task.asOf) setCutoff(task.asOf); initialSelection.current = "" }
        }
        setLoading(false)
      } catch (failure) { if (!disposed && !controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
      finally {
        inFlight = false
        if (disposed) return
        // 后台标签页不轮询；进行中 3 秒，空闲 15 秒，避免已完成任务仍持续请求。
        if (document.visibilityState === "hidden") return
        timer = setTimeout(() => void refresh(), pollingActive ? 3000 : 15000)
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return
      clearTimeout(timer)
      void refresh()
    }
    document.addEventListener("visibilitychange", onVisibility)
    void refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility) }
  }, [documentId, selected, reload, onSessionUnavailable, kind])
  useEffect(() => () => { pending.current?.abort() }, [])

  const task = detail?.id === selected ? detail : null
  const active = task?.state === "queued" || task?.state === "running"
  const alreadyRunning = tasks.some(item => item.revisionId === revisionId && ["queued", "running"].includes(item.state))
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || !ready || !configurationId || dirty || busy || alreadyRunning || !consent || (needsDraftConsent && !draftConsent)) return
    const controller = new AbortController()
    pending.current = controller; setSubmitting(true); setError("")
    const input: SubmitReview = { documentId, revisionId,
      context: { scene: "auto", role: "专业分包人", region: region.trim() },
      externalProcessingConsent: true, unreviewedMaterialsConsent: draftConsent, configurationId, generateRevision: !business && generateRevision,
      ...(business ? { task: kind, asOf: cutoff } : {}),
      ...(kind === "collection-letter" ? { letterPlan, ...(paymentTaskId ? { paymentTaskId } : {}), ...(evidenceTaskId ? { evidenceTaskId } : {}) } : {}) }
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
  return <section aria-label="文档业务处理" className="flex flex-col gap-6 p-4">
    <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
      <label className="grid gap-2 text-sm">处理业务<NativeSelect aria-label="处理业务" value={kind} disabled={submitting} onChange={event => { setKind(event.target.value as keyof typeof documentTaskLabels); setSelected(""); setDetail(null); setConsentRevision(""); operation.current = null }}>{Object.entries(documentTaskLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></label>
      {!business && <p className="text-sm text-muted-foreground">审查立场：专业分包人</p>}
      {!business && <label className="grid gap-2 text-sm">项目地域<Input value={region} required maxLength={100} placeholder="如：上海" disabled={submitting} onChange={event => { setRegion(event.target.value); setConsentRevision("") }} /></label>}
      {business && <label className="grid gap-2 text-sm">核对截止日<Input type="date" value={cutoff} required disabled={submitting} onChange={event => { setCutoff(event.target.value); setConsentRevision(""); setPaymentTaskId(""); setEvidenceTaskId("") }} /></label>}
      {kind === "collection-letter" && <div className="space-y-3">
        {([['sender', '发函方'], ['recipient', '收函方'], ['contractTitle', '合同名称或编号'], ['demand', '履行要求'], ['method', '拟用送达方式'], ['address', '拟送达地址']] as const).map(([field, label]) => <label key={field} className="grid gap-2 text-sm">{label}<Input value={letterPlan[field]} maxLength={field === "demand" ? 300 : field === "address" || field === "contractTitle" ? 200 : 100} disabled={submitting} onChange={event => changePlan(field, event.target.value)} /></label>)}
        <label className="grid gap-2 text-sm">拟发送日期<Input type="date" required value={letterPlan.plannedDate} disabled={submitting} onChange={event => changePlan("plannedDate", event.target.value)} /></label>
        {([['payment-reconciliation', '引用款项结果', paymentTaskId, setPaymentTaskId], ['evidence-organization', '引用证据结果', evidenceTaskId, setEvidenceTaskId]] as const).map(([sourceKind, label, value, setValue]) => <label key={sourceKind} className="grid gap-2 text-sm">{label}<NativeSelect aria-label={label} value={value} disabled={submitting} onChange={event => { setValue(event.target.value); setConsentRevision("") }}><NativeSelectOption value="">不引用</NativeSelectOption>{tasks.filter(item => item.kind === sourceKind && item.revisionId === revisionId && item.asOf === cutoff && ["success", "partial"].includes(item.state)).map(item => <NativeSelectOption value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString("zh-CN")} · {taskDisplayState(item)}</NativeSelectOption>)}</NativeSelect></label>)}
      </div>}
      {!business && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={generateRevision} disabled={submitting} onChange={event => { setGenerateRevision(event.target.checked); setConsentRevision("") }} /><span>生成合同修订稿，并核对修改后的合同（会增加约 2–3 倍模型调用与 token）</span></label>}
      {needsDraftConsent && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draftConsent} disabled={submitting} onChange={event => setDraftConsent(event.target.checked)} /><span>我已知悉审查依据尚未核对，结果需人工复核。</span></label>}
      {ready && configuration && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={submitting} onChange={event => setConsentRevision(event.target.checked ? revisionId : "")} /><span>我有权将此保存版本{kind === "collection-letter" ? "、上述拟发送安排及所选成果" : ""}发送至 {configuration.providerHost} 进行本次{documentTaskLabels[kind]}。{business && "最多 3 次模型请求。"}</span></label><Collapsible><CollapsibleTrigger asChild><Button type="button" variant="link" size="sm" className="px-0">查看模型与保留说明</Button></CollapsibleTrigger><CollapsibleContent className="space-y-1 text-xs text-muted-foreground"><p>模型：{configuration.model}。记录最多保留 {configuration.retentionDays} 天，原资料先到期时一并清理。</p><p>累计已记录 token 达到 {tokenLimit?.toLocaleString("zh-CN")} 时停止发送下一次请求。{business && "格式修正及独立核对共用 3 次请求上限。"}</p></CollapsibleContent></Collapsible></>}
      {dirty && <p role="status" className="text-sm">请先保存更改，再开始处理。</p>}
      {(business ? configuration?.documentTasks?.error : configuration?.error) && <p role="alert" className="text-sm text-destructive">{business ? configuration?.documentTasks?.error : configuration?.error}</p>}
      <Button type="submit" disabled={loading || !ready || submitting || busy || dirty || alreadyRunning || (business ? !cutoff : !region.trim()) || !consent || (needsDraftConsent && !draftConsent)}>
        {submitting && <LoaderCircleIcon className="animate-spin" />}{business ? "开始" + documentTaskLabels[kind] : generateRevision ? "审查并生成修订稿" : "开始审查"}
      </Button>
    </form>
    {error && <div className="flex flex-col gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" disabled={submitting} onClick={() => { setError(""); cachedDetail.current = null; setReload(value => value + 1) }}>重新读取</Button></div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取任务</p>}
    {tasks.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">处理记录（{tasks.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-3">{tasks.map(item => <Button type="button" key={item.id} variant={selected === item.id ? "secondary" : "ghost"} className="h-auto justify-start whitespace-normal text-left" onClick={() => { setSelected(item.id); setKind(item.kind ?? "contract-review"); setConsentRevision(""); setError("") }}>
        <span className="flex min-w-0 flex-col gap-0.5"><span className="truncate font-medium">{item.title}</span>
          <span className="text-xs text-muted-foreground">{documentTaskLabels[item.kind ?? "contract-review"]} · {new Date(item.createdAt).toLocaleString("zh-CN")} · {taskDisplayState(item)}</span></span>
      </Button>)}</CollapsibleContent>
    </Collapsible>}
    {task && <div className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{taskDisplayState(task)}</Badge><span role="status" className="text-sm">{taskDisplayStage(task)}</span></div>
      <p className="text-sm">{taskStateHint(task)}</p>
      {task.sourceTaskId && <p className="text-sm text-muted-foreground">基于审查任务 <span className="font-mono">{task.sourceTaskId.slice(0, 8)}</span> 的主审结果生成。</p>}
      <p className="text-sm text-muted-foreground">{new Date(task.createdAt).toLocaleString("zh-CN")} · 保留至 {new Date(task.expiresAt).toLocaleString("zh-CN")}</p>
      {task.revisionId !== revisionId && <div role="note" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
        <p className="font-medium">历史保存版本</p>
        <p>此结果基于提交时的保存版本，当前文档已有新的保存版本；当前修改未包含在结果中。重新提交任务才会审查新版本。</p>
      </div>}
      {active && <p className="text-sm">已读 {task.progress.readParagraphCount} / {task.progress.paragraphCount} 段，已提交 {task.progress.submittedRuleCount} 条检查。</p>}
      {task.result?.usage && <p className="text-sm text-muted-foreground">本次 {task.callsUsed} 次调用 · 已记录 {task.result.usage.totalTokens.toLocaleString("zh-CN")} token{task.maxKnownTokens ? ` / 停止阈值 ${task.maxKnownTokens.toLocaleString("zh-CN")}` : ""}</p>}
      {active && task.progress.agentRole === "auditor" && <p className="text-sm">{task.result?.collaboration?.version === "multi-agent-revision-v1" ? "核对修改后合同" : "AI 复查"}：{task.progress.auditedRuleCount ?? 0} / {task.result?.documentAnalysis ? task.progress.submittedRuleCount : task.result?.findings.length ?? task.progress.submittedRuleCount} 条</p>}
      {task.error && !task.result?.errors.some(item => item.code === task.error?.code) && <p role="alert" className="text-sm text-destructive">{task.error.code === "REVIEW_TOKEN_BUDGET_EXHAUSTED" && configuration
        ? `已达到累计 ${(task.maxKnownTokens ?? configuration.maxKnownTokens).toLocaleString("zh-CN")} token 停止阈值；已有结果保留，可重新提交新任务。`
        : task.error.message}</p>}
      {active && <Button type="button" variant="outline" disabled={submitting} onClick={() => void action("cancel")}>取消任务</Button>}
      {!active && !task.result?.documentAnalysis?.audit.complete && task.state !== "success" && task.stage !== "cancelled" && !["REVIEW_INPUT_EMPTY", "REVIEW_REVISION_UNSAFE", "REVIEW_TOKEN_BUDGET_EXHAUSTED"].includes(task.error?.code ?? "") && !task.result?.collaboration?.revision?.export && (!task.result?.sceneSelection || task.result.sceneSelection.status === "matched") && task.attempt < 3 && task.callsUsed < task.maxCalls && <Button type="button" variant="outline" disabled={submitting} onClick={() => setRetryDialog(true)}>继续原任务</Button>}
      {task.result && (task.result.documentAnalysis ? <DocumentAgentReport result={task.result} taskId={active ? undefined : task.id} onSessionUnavailable={onSessionUnavailable} /> : <ContractReviewReport result={task.result} taskId={active ? undefined : task.id} onSessionUnavailable={onSessionUnavailable} onRevisionCreated={id => { setSelected(id); setReload(value => value + 1) }} />)}
    </div>}
    <AlertDialog open={retryDialog} onOpenChange={setRetryDialog}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>继续原任务？</AlertDialogTitle><AlertDialogDescription>将使用原保存版本、原处理条件和模型服务继续处理，可能产生费用。已有结果保留，调用预算和保留期限不会重置。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button type="button" disabled={submitting} onClick={() => void action("retry")}>同意并继续</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
}
