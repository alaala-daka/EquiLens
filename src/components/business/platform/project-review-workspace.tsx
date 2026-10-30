"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { FileTextIcon, LoaderCircleIcon, ScaleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ExportRef, ResultReview, ResultValidation } from "@/lib/business/contracts"
import {
  createProjectReviewsClient,
  type ProjectBudgetView,
  type ProjectResultView,
  type ProjectReviewMaterial,
  type ProjectTaskView,
} from "@/lib/business/reviews-client"
import { errorMessage } from "@/lib/documents/types"
import { downloadDocument } from "@/lib/documents/editor-access"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"
import {
  applyReviewDraft,
  buildReviewSubmission,
  budgetDisplay,
  contractReviewResults,
  coverageStatusLabel,
  defaultReviewDraft,
  exportBaseName,
  findEquivalentActiveTask,
  formatElapsedDuration,
  formatReviewTime,
  hasPendingMaterials,
  isActiveTask,
  isMaterialSelected,
  isReviewDraftDirty,
  materialAvailability,
  mergeResultRows,
  mergeTaskView,
  nextSubmissionOperation,
  normalizeReviewRegion,
  parseStateLabel,
  parseYuanToFen,
  projectTaskHint,
  projectTaskStageLabel,
  projectTaskStateLabel,
  readReviewResult,
  reportDocumentTitle,
  resultForTask,
  reviewDecisionLabel,
  reviewPollIntervalMs,
  reviewSceneOptions,
  reviewSubmissionSignature,
  shouldPollReview,
  taskConditionsSummary,
  taskMaterialLabels,
  toggleReviewMaterial,
  validationStatusLabel,
  type ReviewDraft,
  type SubmissionOperation,
} from "./review-state"
import { browserReviewDraftStorage, clearReviewDraft, readReviewDraft, writeReviewDraft } from "./review-draft"
import { ReviewResultPanel, type ReviewPanelBusy } from "./review-result-panel"

const regions = ["北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门", "台湾"] as const

type WorkspaceBusy = "" | "submit" | "refresh"
type Selection = { taskId: string; resultId: string }

/**
 * Project contract-review workspace (B2a).
 *
 * Flow: select parsed materials and an explicit scene → submit a persisted task
 * → poll the persisted task detail every five seconds until terminal → open
 * the machine result linked by task provenance → revalidate → approve/reject →
 * create and download one versioned Word export.
 *
 * Every request is bound to this project instance: late responses from another
 * project or after unmount are rejected by the client guard. A read-only
 * member sees tasks, results and existing exports but cannot submit, review or
 * create an export.
 */
export function ProjectReviewWorkspace({ project, active, canEdit, canManage, blocked, isCurrent, onAccessInvalid, onOpenDocuments, registry }: {
  project: ProjectSummary
  active: boolean
  canEdit: boolean
  canManage: boolean
  blocked: boolean
  isCurrent: () => boolean
  onAccessInvalid: (failure: unknown) => void
  onOpenDocuments: () => void
  registry: UnsavedRegistry
}) {
  const [runtime] = useState(() => {
    const life = { alive: true, blocked, editable: canEdit, manage: canManage }
    const instance = createProjectReviewsClient({
      projectId: project.id,
      isCurrent: () => life.alive && isCurrent() && !life.blocked,
      canEdit: () => life.editable,
      canManage: () => life.manage,
      onAccessInvalid,
    })
    return {
      client: instance,
      isCurrent: () => life.alive && isCurrent() && !life.blocked,
      start() { life.alive = true },
      stop() { life.alive = false },
      configure(next: { blocked: boolean; editable: boolean; manage: boolean }) {
        life.blocked = next.blocked
        life.editable = next.editable
        life.manage = next.manage
      },
    }
  })
  const current = useCallback(() => runtime.isCurrent(), [runtime])
  const [actions] = useState(() => new Set<AbortController>())
  const beginAction = useCallback(() => {
    const controller = new AbortController()
    actions.add(controller)
    return controller
  }, [actions])
  const endAction = useCallback((controller: AbortController) => { actions.delete(controller) }, [actions])

  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible")
  const [materials, setMaterials] = useState<ProjectReviewMaterial[]>([])
  const [tasks, setTasks] = useState<ProjectTaskView[]>([])
  const [results, setResults] = useState<ProjectResultView[]>([])
  const [selection, setSelection] = useState<Selection>({ taskId: "", resultId: "" })
  const [draft, setDraft] = useState<ReviewDraft>(defaultReviewDraft)
  const [externalConsent, setExternalConsent] = useState(false)
  const [unreviewedConsent, setUnreviewedConsent] = useState(false)
  const [busy, setBusy] = useState<WorkspaceBusy>("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [pollError, setPollError] = useState("")
  const [submitIssues, setSubmitIssues] = useState<string[]>([])
  const [notice, setNotice] = useState("")
  const [budget, setBudget] = useState<ProjectBudgetView | null>(null)
  const [budgetLoaded, setBudgetLoaded] = useState(false)
  const [budgetError, setBudgetError] = useState("")
  const [budgetBusy, setBudgetBusy] = useState(false)
  const [validationOverride, setValidationOverride] = useState<Record<string, ResultValidation>>({})
  const [resultBusy, setResultBusy] = useState<ReviewPanelBusy>(null)
  const [actionError, setActionError] = useState("")
  const [exports, setExports] = useState<ExportRef[]>([])
  const [exportsError, setExportsError] = useState("")
  const [exportsVersion, setExportsVersion] = useState(0)
  const operation = useRef<SubmissionOperation | null>(null)
  const restored = useRef(false)
  const loadedOnce = useRef(false)
  const client = runtime.client

  useEffect(() => {
    runtime.start()
    return () => {
      runtime.stop()
      for (const controller of actions) controller.abort()
      actions.clear()
    }
  }, [runtime, actions])

  useLayoutEffect(() => {
    runtime.configure({ blocked, editable: canEdit, manage: canManage })
  }, [runtime, blocked, canEdit, canManage])

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  const restoreDraft = useCallback((rows: ProjectReviewMaterial[]) => {
    if (restored.current) return
    restored.current = true
    const stored = readReviewDraft(browserReviewDraftStorage(), project.id)
    if (!stored) return
    const applied = applyReviewDraft(stored, rows)
    if (isReviewDraftDirty(applied)) {
      setDraft(applied)
      if (applied.materials.length < stored.materials.length) setNotice("部分已选材料的版本已变化，请重新确认审查条件。")
    } else if (stored.materials.length > 0) {
      setNotice("已选材料的版本已变化，请重新选择。")
    }
  }, [project.id])

  useEffect(() => {
    if (!active || blocked || !visible) return
    const controller = new AbortController()
    void (async () => {
      if (!loadedOnce.current) setLoading(true)
      setLoadError("")
      try {
        const [materialRows, taskRows, resultRows] = await Promise.all([
          client.listMaterials(controller.signal),
          client.listTasks(controller.signal),
          client.listResults(controller.signal),
        ])
        if (!current() || controller.signal.aborted) return
        loadedOnce.current = true
        setMaterials(materialRows)
        setTasks(taskRows)
        setResults(resultRows)
        setPollError("")
        restoreDraft(materialRows)
        setSelection(previous => {
          const taskId = taskRows.some(task => task.id === previous.taskId) ? previous.taskId : taskRows[0]?.id ?? ""
          const keptResult = previous.resultId && resultRows.some(row => row.resultId === previous.resultId)
          const task = taskRows.find(item => item.id === taskId)
          const found = task ? resultForTask(resultRows, task) : null
          return { taskId, resultId: keptResult ? previous.resultId : found?.resultId ?? "" }
        })
      } catch (failure) {
        if (current() && !controller.signal.aborted) setLoadError(errorMessage(failure))
      } finally {
        if (current() && !controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [active, blocked, visible, reloadToken, client, current, restoreDraft])

  useEffect(() => {
    if (!active || blocked || !canManage) return
    const controller = new AbortController()
    void (async () => {
      try {
        const value = await client.getBudget(controller.signal)
        if (!current() || controller.signal.aborted) return
        setBudget(value)
        setBudgetLoaded(true)
        setBudgetError("")
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          setBudgetLoaded(true)
          setBudgetError(errorMessage(failure))
        }
      }
    })()
    return () => controller.abort()
  }, [active, blocked, canManage, client, current, reloadToken])

  const poll = useCallback(async () => {
    if (!current()) return
    const controller = beginAction()
    try {
      const activeRows = tasks.filter(isActiveTask)
      const [details, materialRows] = await Promise.all([
        activeRows.length ? Promise.all(activeRows.map(task => client.getTask(task.id, controller.signal))) : Promise.resolve([]),
        hasPendingMaterials(materials) ? client.listMaterials(controller.signal) : Promise.resolve(null),
      ])
      if (!current() || controller.signal.aborted) return
      // Apply the poll to the latest state, never to the render-time snapshot.
      setTasks(previous => details.reduce((merged, detail) => mergeTaskView(merged, detail), previous))
      if (materialRows) setMaterials(materialRows)
      setPollError("")
      const finished = details.filter(detail => !isActiveTask(detail))
      if (finished.length) {
        const rows = await client.listResults(controller.signal)
        if (!current() || controller.signal.aborted) return
        setResults(previous => mergeResultRows(previous, rows))
        setSelection(previous => {
          if (previous.resultId && rows.some(row => row.resultId === previous.resultId)) return previous
          // Only link the selected task's own result; never borrow another task's output.
          const selectedFinished = finished.find(task => task.id === previous.taskId)
          const found = selectedFinished ? resultForTask(rows, selectedFinished) : null
          return found ? { ...previous, resultId: found.resultId } : previous
        })
      }
    } catch (failure) {
      if (!current() || controller.signal.aborted) return
      // A transient read failure is not a failed task: keep the last persisted state and offer 重试.
      setPollError(errorMessage(failure))
    } finally {
      endAction(controller)
    }
  }, [beginAction, client, current, endAction, materials, tasks])

  useEffect(() => {
    if (!active || blocked || !visible) return
    if (!shouldPollReview(tasks, materials)) return
    const timer = setTimeout(() => void poll(), reviewPollIntervalMs)
    return () => clearTimeout(timer)
  }, [active, blocked, visible, tasks, materials, poll])

  const selectedTaskId = selection.taskId && tasks.some(task => task.id === selection.taskId)
    ? selection.taskId
    : tasks[0]?.id ?? ""
  const selectedTask = tasks.find(task => task.id === selectedTaskId) ?? null
  const taskResult = selectedTask ? resultForTask(results, selectedTask) : null
  const selectedResultId = selection.resultId && results.some(row => row.resultId === selection.resultId)
    ? selection.resultId
    : taskResult?.resultId ?? ""
  const selectedResult = results.find(row => row.resultId === selectedResultId) ?? null
  const selectedResultVersion = selectedResult?.versionId ?? ""

  useEffect(() => {
    if (!selectedResultId) return
    const controller = new AbortController()
    void (async () => {
      try {
        const rows = await client.listExports(selectedResultId, controller.signal)
        if (!current() || controller.signal.aborted) return
        setExports([...rows].sort((left, right) => right.createdAt.localeCompare(left.createdAt)))
        setExportsError("")
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          setExports([])
          setExportsError(errorMessage(failure))
        }
      }
    })()
    return () => controller.abort()
  }, [selectedResultId, selectedResultVersion, exportsVersion, client, current])

  // Unsaved conditions are kept as a project preparation draft; saving never submits a task.
  useEffect(() => {
    if (!canEdit || blocked || !isReviewDraftDirty(draft)) return
    return registry.register({
      id: `review-draft:${project.id}`,
      label: "审查条件",
      async save() {
        try { return writeReviewDraft(browserReviewDraftStorage(), project.id, draft) } catch { return false }
      },
      discard() {
        clearReviewDraft(browserReviewDraftStorage(), project.id)
        setDraft(defaultReviewDraft())
        setExternalConsent(false)
        setUnreviewedConsent(false)
      },
    })
  }, [canEdit, blocked, draft, project.id, registry])

  const draftDirty = canEdit && isReviewDraftDirty(draft)
  useEffect(() => {
    if (!draftDirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [draftDirty])

  const submission = buildReviewSubmission(draft, materials, { externalProcessing: externalConsent, unreviewedMaterials: unreviewedConsent })
  const signature = reviewSubmissionSignature(submission)
  const equivalentActive = findEquivalentActiveTask(tasks, signature)
  const canSubmitReview = canEdit && !blocked && busy === "" && !equivalentActive && !(canManage && budgetLoaded && !budget)

  function updateDraft(next: ReviewDraft) {
    setDraft(next)
    setSubmitIssues([])
    setNotice("")
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || blocked || busy !== "" || equivalentActive) return
    const issues = [...submission.issues]
    if (canManage && budgetLoaded && !budget) issues.push("请先登记审查预算。")
    if (equivalentActive) issues.push("相同输入的审查任务正在进行，请等待或查看任务状态。")
    if (issues.length) { setSubmitIssues(issues); return }
    const pendingOperation = nextSubmissionOperation(operation.current, signature, () => crypto.randomUUID())
    operation.current = pendingOperation
    setBusy("submit")
    setSubmitIssues([])
    setNotice("")
    const controller = beginAction()
    try {
      const created = await client.submitReview(submission, pendingOperation.key, controller.signal)
      if (!current() || controller.signal.aborted) return
      operation.current = null
      setTasks(rows => mergeTaskView(rows, created.task))
      setSelection({ taskId: created.task.id, resultId: "" })
      setDraft(defaultReviewDraft())
      setExternalConsent(false)
      setUnreviewedConsent(false)
      clearReviewDraft(browserReviewDraftStorage(), project.id)
      setNotice(created.created ? "审查任务已提交。" : "该输入已有审查任务，已打开该任务。")
    } catch (failure) {
      if (!current() || controller.signal.aborted) return
      // Uncertain network failures keep the same operation key so a retry reuses the persisted task.
      setSubmitIssues([errorMessage(failure)])
    } finally {
      endAction(controller)
      if (current()) setBusy("")
    }
  }

  async function runResultAction(kind: ReviewPanelBusy, work: (controller: AbortController) => Promise<void>) {
    if (resultBusy) return
    const controller = beginAction()
    setResultBusy(kind)
    setActionError("")
    try {
      await work(controller)
    } catch (failure) {
      if (current() && !controller.signal.aborted) setActionError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setResultBusy(null)
    }
  }

  function validateResult(result: ProjectResultView) {
    void runResultAction("validate", async controller => {
      const checked = await client.validateResult({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256 }, controller.signal)
      if (!current()) return
      setValidationOverride(rows => ({ ...rows, [`${result.resultId}:${result.versionId}`]: checked }))
    })
  }

  function reviewResult(result: ProjectResultView, decision: ResultReview["decision"], comment: string) {
    void runResultAction("review", async controller => {
      const updated = await client.reviewResult({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256, decision, comment }, controller.signal)
      if (!current()) return
      setResults(rows => rows.map(row => row.resultId === updated.resultId ? updated : row))
      setNotice("复核记录已保存。")
    })
  }

  async function downloadExport(result: ProjectResultView, exportRef: ExportRef) {
    const controller = beginAction()
    setResultBusy("download")
    setExportsError("")
    try {
      const blob = await client.downloadExport(result.resultId, exportRef.exportId, controller.signal)
      if (!current()) return
      downloadDocument(blob, exportBaseName(reportDocumentTitle(result.value)))
    } catch (failure) {
      if (current() && !controller.signal.aborted) setExportsError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setResultBusy(null)
    }
  }

  function createExport(result: ProjectResultView) {
    void runResultAction("export", async controller => {
      const created = await client.createExport({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256 }, controller.signal)
      if (!current()) return
      setExportsVersion(value => value + 1)
      setExports(rows => [created, ...rows.filter(row => row.exportId !== created.exportId)])
      const blob = await client.downloadExport(result.resultId, created.exportId, controller.signal)
      if (!current()) return
      downloadDocument(blob, exportBaseName(reportDocumentTitle(result.value)))
    })
  }

  async function registerBudget(fen: number): Promise<boolean> {
    if (!canManage || budgetBusy) return false
    setBudgetBusy(true)
    setBudgetError("")
    const controller = beginAction()
    try {
      const value = await client.registerBudget(fen, controller.signal)
      if (!current()) return false
      setBudget(value)
      setBudgetLoaded(true)
      return true
    } catch (failure) {
      if (current() && !controller.signal.aborted) setBudgetError(errorMessage(failure))
      return false
    } finally {
      endAction(controller)
      if (current()) setBudgetBusy(false)
    }
  }

  const contractResults = contractReviewResults(results)
  const selectedValidation = selectedResult
    ? validationOverride[`${selectedResult.resultId}:${selectedResult.versionId}`] ?? selectedResult.validation
    : null
  const selectedValue = selectedResult ? readReviewResult(selectedResult.value) : null
  const taskFinishedWithoutResult = Boolean(selectedTask && !isActiveTask(selectedTask) && selectedTask.state !== "failed" &&
    selectedTask.state !== "cancelled" && !selectedResult && !loading)

  return <div className="flex flex-col gap-6">
    {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">状态获取失败：{loadError}</p><Button type="button" variant="outline" onClick={() => setReloadToken(value => value + 1)}>重试</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {canEdit && <form aria-label="提交审查" className="flex flex-col gap-4 rounded-lg border p-4" onSubmit={event => void submit(event)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">审查材料与条件</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy !== ""} onClick={() => setReloadToken(value => value + 1)}>刷新材料</Button>
      </div>
      {materials.length === 0 ? (loading ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取审查材料</p> : <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>暂无可审查材料</EmptyTitle></EmptyHeader><Button type="button" variant="outline" onClick={onOpenDocuments}>前往文档上传资料</Button></Empty>) : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>选择</TableHead><TableHead>材料</TableHead><TableHead>版本</TableHead><TableHead>解析状态</TableHead><TableHead>覆盖范围</TableHead></TableRow></TableHeader><TableBody>
        {materials.map(material => {
          const availability = materialAvailability(material)
          const selected = isMaterialSelected(draft, material.id)
          return <TableRow key={material.id}>
            <TableCell><input type="checkbox" aria-label={`选择 ${material.title}`} checked={selected} disabled={busy === "submit" || (!selected && (!availability.reviewable || draft.materials.length >= 10))} onChange={() => updateDraft(toggleReviewMaterial(draft, material))} /></TableCell>
            <TableCell className="whitespace-normal">{material.title}<Badge variant="outline" className="ml-2">{material.format.toUpperCase()}</Badge></TableCell>
            <TableCell className="whitespace-normal break-all text-xs">{material.versionId}</TableCell>
            <TableCell>{parseStateLabel(material.parseState)}{!availability.reviewable && <p className="text-xs text-muted-foreground">{availability.reason}</p>}</TableCell>
            <TableCell className="whitespace-normal">{material.coverage ? <div className="space-y-1"><span>{coverageStatusLabel(material.coverage.status)} · {material.coverage.textLength} 字符</span>{material.coverage.findings.map((finding, index) => <p key={index} className="text-xs text-muted-foreground">{finding.code} · {finding.location}</p>)}</div> : "无解析快照"}</TableCell>
          </TableRow>
        })}
      </TableBody></Table></div>}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm">审查场景<NativeSelect aria-label="审查场景" value={draft.scene} disabled={busy === "submit"} onChange={event => updateDraft({ ...draft, scene: event.target.value as ReviewDraft["scene"] })}>{reviewSceneOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm">项目地域<Input list="review-project-regions" value={draft.region} required maxLength={100} placeholder="如：上海" disabled={busy === "submit"} onBlur={() => updateDraft({ ...draft, region: normalizeReviewRegion(draft.region) })} onChange={event => updateDraft({ ...draft, region: event.target.value })} /></label>
        <datalist id="review-project-regions">{regions.map(region => <option key={region} value={region} />)}</datalist>
      </div>
      <p className="text-xs text-muted-foreground">地域用于确定适用规则和审查范围；审查立场为专业分包人。</p>
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">数据与外发确认</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={externalConsent} disabled={busy === "submit"} onChange={event => { setExternalConsent(event.target.checked); setSubmitIssues([]) }} /><span>我同意将所选的已保存材料版本发送给第三方模型服务，用于本次合同审查。</span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={unreviewedConsent} disabled={busy === "submit"} onChange={event => { setUnreviewedConsent(event.target.checked); setSubmitIssues([]) }} /><span>我知悉审查依据尚未签核，结果需人工复核。</span></label>
      </div>
      {submitIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{submitIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canSubmitReview}>{busy === "submit" ? "正在提交" : equivalentActive ? "相同任务正在进行" : "提交审查"}</Button>
        {canManage && budgetLoaded && !budget && <span className="text-xs text-muted-foreground">请先登记审查预算。</span>}
        <span className="text-xs text-muted-foreground">任务提交后进入后台执行；离开页面不会取消任务。</span>
      </div>
    </form>}

    {canEdit && <section aria-label="审查预算" className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">审查预算</h2>
        {canManage && <BudgetSheet budget={budget} busy={budgetBusy} error={budgetError} onRegister={registerBudget} />}
      </div>
      {!canManage && <p role="note" className="text-sm text-muted-foreground">审查预算由项目管理员登记；未登记时任务将无法执行付费模型调用。</p>}
      {canManage && (budgetError
        ? <p role="alert" className="text-sm text-destructive">预算读取失败：{budgetError}</p>
        : !budgetLoaded
          ? <p role="status" className="text-sm">正在读取审查预算</p>
          : budget
            ? <p className="text-sm">预算上限 {budgetDisplay(budget).limit} · 已预留与已用合计 {budgetDisplay(budget).committed} · 剩余 {budgetDisplay(budget).remaining}</p>
            : <p role="note" className="text-sm">尚未登记审查预算，登记后任务才可发起付费模型调用。</p>)}
    </section>}

    <section aria-label="审查任务" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">审查任务</h2>
        <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => setReloadToken(value => value + 1)}>刷新</Button>
      </div>
      {!canEdit && <p role="note" className="text-sm text-muted-foreground">只读成员可查看已有任务与成果，不能提交、复核或导出。</p>}
      {pollError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">状态获取失败：{pollError}</p><Button type="button" variant="outline" onClick={() => setReloadToken(value => value + 1)}>重试</Button></div>}
      {loading && tasks.length === 0 && <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取审查任务与成果</p>}
      {!loading && tasks.length === 0 && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><ScaleIcon /></EmptyMedia><EmptyTitle>暂无审查任务</EmptyTitle></EmptyHeader></Empty>}
      {tasks.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>提交时间</TableHead><TableHead>状态</TableHead><TableHead>阶段</TableHead><TableHead>调用次数</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {tasks.map(task => <TableRow key={task.id}>
          <TableCell className="whitespace-normal">{formatReviewTime(task.createdAt)}</TableCell>
          <TableCell>{projectTaskStateLabel(task.state)}</TableCell>
          <TableCell>{projectTaskStageLabel(task)}</TableCell>
          <TableCell>{task.callsUsed} / {task.maxCalls}</TableCell>
          <TableCell><Button type="button" variant={selectedTaskId === task.id ? "secondary" : "link"} disabled={busy === "submit"} onClick={() => { setSelection({ taskId: task.id, resultId: "" }); setActionError("") }}>查看</Button></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
      {selectedTask && <article aria-label="任务详情" className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={selectedTask.state === "failed" ? "destructive" : "outline"}>{projectTaskStateLabel(selectedTask.state)}</Badge>
          <span role="status" className="text-sm">{projectTaskStageLabel(selectedTask)}</span>
          <span className="text-xs text-muted-foreground">已用时 {formatElapsedDuration(selectedTask.elapsedMs) || "0 秒"} · 调用 {selectedTask.callsUsed} / {selectedTask.maxCalls} 次{selectedTask.attempt > 0 ? ` · 第 ${selectedTask.attempt} / ${selectedTask.maxAttempts} 次尝试` : ""}</span>
        </div>
        <p className="text-sm">{projectTaskHint(selectedTask)}</p>
        {selectedTask.error && <p role="alert" className="text-sm text-destructive">{selectedTask.error.message}</p>}
        <p className="text-sm">审查场景：{taskConditionsSummary(selectedTask).scene} · 地域：{taskConditionsSummary(selectedTask).region} · 立场：{taskConditionsSummary(selectedTask).role}</p>
        <div className="space-y-1">
          <p className="text-sm font-medium">提交材料</p>
          {taskMaterialLabels(selectedTask, materials).length === 0 ? <p className="text-sm text-muted-foreground">未记录</p> : <ul className="list-disc space-y-1 pl-4 text-sm">
            {taskMaterialLabels(selectedTask, materials).map(item => <li key={item.versionId} className="break-all">{item.title}（{item.versionId}）</li>)}
          </ul>}
        </div>
      </article>}
    </section>

    <section aria-label="审查成果" className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">审查成果</h2>
      {contractResults.length === 0 && !loading && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>暂无审查成果</EmptyTitle></EmptyHeader></Empty>}
      {contractResults.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>文档</TableHead><TableHead>生成时间</TableHead><TableHead>校验</TableHead><TableHead>复核</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {contractResults.map(row => {
          const rowValidation = validationOverride[`${row.resultId}:${row.versionId}`] ?? row.validation
          return <TableRow key={row.resultId}>
            <TableCell className="whitespace-normal">{reportDocumentTitle(row.value)}</TableCell>
            <TableCell className="whitespace-normal">{formatReviewTime(row.createdAt)}</TableCell>
            <TableCell>{validationStatusLabel(rowValidation.status)}</TableCell>
            <TableCell>{reviewDecisionLabel(row.review)}</TableCell>
            <TableCell><Button type="button" variant={selectedResultId === row.resultId ? "secondary" : "link"} onClick={() => { setActionError(""); setSelection(previous => {
              const taskId = row.provenance?.taskId
              return { taskId: taskId && tasks.some(task => task.id === taskId) ? taskId : previous.taskId, resultId: row.resultId }
            }) }}>查看</Button></TableCell>
          </TableRow>
        })}
      </TableBody></Table></div>}
      {taskFinishedWithoutResult && <p role="alert" className="text-sm text-destructive">该任务已结束，但未读取到对应成果；请刷新后重试。</p>}
      {selectedResult && selectedValidation && <ReviewResultPanel
        result={selectedResult}
        value={selectedValue}
        validation={selectedValidation}
        exports={exports}
        exportsError={exportsError}
        canEdit={canEdit}
        busy={resultBusy}
        error={actionError}
        onValidate={() => validateResult(selectedResult)}
        onReview={(decision, comment) => reviewResult(selectedResult, decision, comment)}
        onCreateExport={() => createExport(selectedResult)}
        onDownloadExport={exportRef => void downloadExport(selectedResult, exportRef)}
      />}
    </section>
  </div>
}

function BudgetSheet({ budget, busy, error, onRegister }: { budget: ProjectBudgetView | null; busy: boolean; error: string; onRegister(fen: number): Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const [localError, setLocalError] = useState("")
  const display = budget ? budgetDisplay(budget) : null
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const parsed = parseYuanToFen(value)
    if (!parsed.ok) { setLocalError(parsed.message); return }
    setLocalError("")
    if (await onRegister(parsed.fen)) {
      setValue("")
      setOpen(false)
    }
  }
  return <Sheet open={open} onOpenChange={next => { if (busy) return; setOpen(next); if (!next) { setValue(""); setLocalError("") } }}>
    <SheetTrigger asChild><Button type="button" variant="outline" size="sm">{budget ? "调整预算" : "登记预算"}</Button></SheetTrigger>
    <SheetContent className="overflow-auto">
      <SheetHeader><SheetTitle>{budget ? "调整审查预算" : "登记审查预算"}</SheetTitle></SheetHeader>
      <form className="flex flex-col gap-4 px-4 pb-4" onSubmit={event => void submit(event)}>
        {display && <p className="text-sm">当前上限：{display.limit}；已预留与已用合计：{display.committed}；剩余：{display.remaining}。</p>}
        <FieldGroup>
          <Field><FieldLabel htmlFor="review-budget-limit">预算上限（元）</FieldLabel><Input id="review-budget-limit" inputMode="decimal" required maxLength={24} placeholder="例如 3000" value={value} disabled={busy} onChange={event => { setValue(event.target.value); setLocalError("") }} /></Field>
        </FieldGroup>
        {(localError || error) && <p role="alert" className="text-sm text-destructive">{localError || error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "正在登记" : "确认登记"}</Button>
      </form>
    </SheetContent>
  </Sheet>
}
