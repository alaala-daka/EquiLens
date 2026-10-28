"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { ContractReviewReport, CitationLocatorContext, type CitationLocator } from "@/components/contract-review-report"
import { DocumentAgentReport } from "@/components/document-agent-report"
import { documentTaskLabels, type LetterPlan } from "@/lib/document-agent/types"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { listReviewTasks, readReviewTask, createReviewTask, actOnReviewTask } from "@/lib/contract-reviews/client"
import { taskDisplayStage, taskDisplayState, taskStateHint, type ReviewAvailability, type ReviewTask, type SubmitReview } from "@/lib/contract-reviews/types"
import { errorMessage } from "@/lib/documents/types"
import { DocumentSessionError } from "@/lib/documents/client"
import { REGIONS, normalizeRegion } from "@/lib/contract-reviews/regions"
import type { SceneId } from "../../tools/contract-review/src/scenes"

function elapsedLabel(from: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function ContractReviewPanel({ documentId, revisionId, dirty, busy, initialTaskId, onSessionUnavailable, onLocateCitation }: {
  documentId: string; revisionId: string; dirty: boolean; busy: boolean; initialTaskId?: string
  onSessionUnavailable?: (failure: DocumentSessionError) => void
  onLocateCitation?: CitationLocator
}) {
  const [configuration, setConfiguration] = useState<ReviewAvailability | null>(null)
  const [tasks, setTasks] = useState<ReviewTask[]>([])
  const [selected, setSelected] = useState(initialTaskId ?? "")
  const [detail, setDetail] = useState<ReviewTask | null>(null)
  // 地域是用户确认的审查条件，不预填，避免默认值被直接提交。
  const [region, setRegion] = useState("")
  const [manualScene, setManualScene] = useState<{ sourceTaskId: string; scene: SceneId | ""; reason: string } | null>(null)
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
    if (pending.current || !ready || !configurationId || dirty || busy || alreadyRunning || !consent || (needsDraftConsent && !draftConsent) || (!business && manualScene && (!manualScene.scene || !manualScene.reason.trim()))) return
    const controller = new AbortController()
    pending.current = controller; setSubmitting(true); setError("")
    const input: SubmitReview = { documentId, revisionId,
      context: { scene: !business && manualScene?.scene ? manualScene.scene : "auto", role: "专业分包人", region: normalizeRegion(region) },
      ...(!business && manualScene?.scene ? { sceneSource: "user" as const, sceneSourceTaskId: manualScene.sourceTaskId, sceneReason: manualScene.reason.trim() } : {}),
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
      operation.current = null; setManualScene(null); setConsentRevision(""); setDraftConsent(false); setReload(value => value + 1)
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
      {!business && manualScene && <div className="space-y-3">
        <p className="text-sm">基于任务 {manualScene.sourceTaskId.slice(0, 8)} 手动重选</p>
        <label className="grid gap-2 text-sm">审查场景<NativeSelect required aria-label="审查场景" disabled={submitting} value={manualScene.scene} onChange={event => { setManualScene({ ...manualScene, scene: event.target.value as SceneId }); setConsentRevision("") }}><NativeSelectOption value="">请选择</NativeSelectOption>{configuration?.sceneCandidates?.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.label}</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm">选择理由<Input required maxLength={500} disabled={submitting} value={manualScene.reason} onChange={event => { setManualScene({ ...manualScene, reason: event.target.value }); setConsentRevision("") }} /></label>
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => { setManualScene(null); setConsentRevision("") }}>改为自动识别</Button>
      </div>}
      {!business && <div className="grid gap-2">
        <label className="grid gap-2 text-sm">项目地域<Input list="review-regions" value={region} required maxLength={100} placeholder="如：上海" disabled={submitting} onBlur={() => setRegion(normalizeRegion(region))} onChange={event => { setRegion(event.target.value); setConsentRevision("") }} /></label>
        <datalist id="review-regions">{REGIONS.map(item => <option key={item} value={item} />)}</datalist>
        <p className="text-xs text-muted-foreground">地域用于确定适用的地方规则和审查范围；可输入省级行政区，如“上海”或“北京市”。</p>
      </div>}
      {business && <label className="grid gap-2 text-sm">核对截止日<Input type="date" value={cutoff} required disabled={submitting} onChange={event => { setCutoff(event.target.value); setConsentRevision(""); setPaymentTaskId(""); setEvidenceTaskId("") }} /></label>}
      {kind === "collection-letter" && <div className="space-y-3">
        {([['sender', '发函方'], ['recipient', '收函方'], ['contractTitle', '合同名称或编号'], ['demand', '履行要求'], ['method', '拟用送达方式'], ['address', '拟送达地址']] as const).map(([field, label]) => <label key={field} className="grid gap-2 text-sm">{label}<Input value={letterPlan[field]} maxLength={field === "demand" ? 300 : field === "address" || field === "contractTitle" ? 200 : 100} disabled={submitting} onChange={event => changePlan(field, event.target.value)} /></label>)}
        <label className="grid gap-2 text-sm">拟发送日期<Input type="date" required value={letterPlan.plannedDate} disabled={submitting} onChange={event => changePlan("plannedDate", event.target.value)} /></label>
        {([['payment-reconciliation', '引用款项结果', paymentTaskId, setPaymentTaskId], ['evidence-organization', '引用证据结果', evidenceTaskId, setEvidenceTaskId]] as const).map(([sourceKind, label, value, setValue]) => <label key={sourceKind} className="grid gap-2 text-sm">{label}<NativeSelect aria-label={label} value={value} disabled={submitting} onChange={event => { setValue(event.target.value); setConsentRevision("") }}><NativeSelectOption value="">不引用</NativeSelectOption>{tasks.filter(item => item.kind === sourceKind && item.revisionId === revisionId && item.asOf === cutoff && ["success", "partial"].includes(item.state)).map(item => <NativeSelectOption value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString("zh-CN")} · {taskDisplayState(item)}</NativeSelectOption>)}</NativeSelect></label>)}
      </div>}
      {!business && <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">审查选项</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={generateRevision} disabled={submitting} onChange={event => { setGenerateRevision(event.target.checked); setConsentRevision("") }} /><span>同时生成合同修订建议（会增加处理时间和费用）</span></label>
      </div>}
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">数据与外发确认</p>
        {needsDraftConsent && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draftConsent} disabled={submitting} onChange={event => setDraftConsent(event.target.checked)} /><span>我知悉审查依据尚未核对，结果需人工复核。</span></label>}
        {ready && configuration && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={submitting} onChange={event => setConsentRevision(event.target.checked ? revisionId : "")} /><span>我同意将当前保存版本{kind === "collection-letter" ? "、上述拟发送安排及所选成果" : ""}发送给第三方模型服务，用于本次{documentTaskLabels[kind]}。{business && "预计最多 3 次请求。"}</span></label><Collapsible><CollapsibleTrigger asChild><Button type="button" variant="link" size="sm" className="px-0">查看服务与留存说明</Button></CollapsibleTrigger><CollapsibleContent className="space-y-1 text-xs text-muted-foreground"><p>服务地址：{configuration.providerHost}。模型：{configuration.model}。记录最多保留 {configuration.retentionDays} 天，原资料先到期时一并清理。</p><p>模型交互记录：{configuration.exchangeRetention === "full" ? "保存请求与响应全文" : "仅保存摘要与哈希"}，随任务记录在 {configuration.retentionDays} 天内清理。</p></CollapsibleContent></Collapsible></>}
      </div>
      {dirty && <p role="status" className="text-sm">请先保存更改，再开始处理。</p>}
      {(business ? configuration?.documentTasks?.error : configuration?.error) && <p role="alert" className="text-sm text-destructive">{business ? configuration?.documentTasks?.error : configuration?.error}</p>}
      <Button type="submit" disabled={loading || !ready || submitting || busy || dirty || alreadyRunning || (business ? !cutoff : !region.trim()) || !consent || (needsDraftConsent && !draftConsent)}>
        {submitting && <LoaderCircleIcon className="animate-spin" />}{business ? "开始" + documentTaskLabels[kind] : manualScene ? "新建审查并检查场景适配" : generateRevision ? "审查并生成修订稿" : "开始审查"}
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
      {task.sourceTaskId && <p className="text-sm text-muted-foreground">基于之前的审查结果生成。</p>}
      {task.sceneReselection && <p className="text-sm text-muted-foreground">基于之前的停止任务手动重选 · {task.sceneReselection.reason}</p>}
      <p className="text-sm text-muted-foreground">{new Date(task.createdAt).toLocaleString("zh-CN")} · 保留至 {new Date(task.expiresAt).toLocaleString("zh-CN")}</p>
      {task.revisionId !== revisionId && <div role="note" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
        <p className="font-medium">历史保存版本</p>
        <p>此结果基于提交时的保存版本，当前文档已有新的保存版本；当前修改未包含在结果中。重新提交任务才会审查新版本。</p>
      </div>}
      {active && <p className="text-sm">正在处理，已用时 {elapsedLabel(task.createdAt)}；已读 {task.progress.readParagraphCount} / {task.progress.paragraphCount} 段，已提交 {task.progress.submittedRuleCount} 条检查。</p>}
      {!active && ["partial", "failed"].includes(task.state) && <p className="text-sm">处理停在「{taskDisplayStage(task)}」，已有结果保留。</p>}
      {active && task.progress.agentRole === "auditor" && <p className="text-sm">{task.result?.collaboration?.version === "multi-agent-revision-v1" ? "核对修改后合同" : "AI 复查"}：{task.progress.auditedRuleCount ?? 0} / {task.result?.documentAnalysis ? task.progress.submittedRuleCount : task.result?.findings.length ?? task.progress.submittedRuleCount} 条</p>}
      {task.error && !task.result?.errors.some(item => item.code === task.error?.code) && <p role="alert" className="text-sm text-destructive">{task.error.code === "REVIEW_TOKEN_BUDGET_EXHAUSTED"
        ? "本次处理达到调用上限；已有结果保留，可重新提交新任务。"
        : task.error.message}</p>}
      {active && <Button type="button" variant="outline" disabled={submitting} onClick={() => void action("cancel")}>取消任务</Button>}
      {!active && task.revisionId === revisionId && ["REVIEW_SCENE_UNCERTAIN", "REVIEW_SCENE_UNSUPPORTED"].includes(task.error?.code ?? "") && <Button type="button" variant="outline" disabled={submitting || dirty || busy} onClick={() => { setKind("contract-review"); setManualScene({ sourceTaskId: task.id, scene: "", reason: "" }); setConsentRevision("") }}>手动选择场景后新建审查</Button>}
      {!active && !task.result?.documentAnalysis?.audit.complete && task.state !== "success" && task.stage !== "cancelled" && !["REVIEW_INPUT_EMPTY", "REVIEW_REVISION_UNSAFE", "REVIEW_TOKEN_BUDGET_EXHAUSTED"].includes(task.error?.code ?? "") && !task.result?.collaboration?.revision?.export && (!task.result?.sceneSelection || task.result.sceneSelection.status === "matched") && task.attempt < 3 && task.callsUsed < task.maxCalls && <Button type="button" variant="outline" disabled={submitting} onClick={() => setRetryDialog(true)}>继续原任务</Button>}
      {task.result && <CitationLocatorContext.Provider value={onLocateCitation ?? null}>
        {task.result.documentAnalysis ? <DocumentAgentReport result={task.result} taskId={active ? undefined : task.id} onSessionUnavailable={onSessionUnavailable} /> : <ContractReviewReport result={task.result} taskId={active ? undefined : task.id} onSessionUnavailable={onSessionUnavailable} onRevisionCreated={id => { setSelected(id); setReload(value => value + 1) }} />}
      </CitationLocatorContext.Provider>}
    </div>}
    <AlertDialog open={retryDialog} onOpenChange={setRetryDialog}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>继续原任务？</AlertDialogTitle><AlertDialogDescription>将使用原保存版本、原处理条件和模型服务继续处理，可能产生费用。已有结果保留，调用预算和保留期限不会重置。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button type="button" disabled={submitting} onClick={() => void action("retry")}>同意并继续</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>
}
