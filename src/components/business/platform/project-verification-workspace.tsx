"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { FileTextIcon, LoaderCircleIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createProjectMaterialsClient, type SnapshotFragment } from "@/lib/business/materials-client"
import {
  createVerificationsClient,
  type ProjectBudgetView, type VerificationDetail, type VerificationFieldView,
  type VerificationMaterial, type VerificationResultView, type VerificationTaskView,
} from "@/lib/business/verifications-client"
import type { ExportRef, ResultReview, ResultValidation } from "@/lib/business/contracts"
import type { VerificationListSummary } from "@/lib/business/verification-types"
import type { RequirementSetValue } from "@/lib/business/verification-types"
import { errorMessage } from "@/lib/documents/types"
import { downloadDocument } from "@/lib/documents/editor-access"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"
import { VerificationFieldPanel, VerificationRecordPanel } from "./verification-evidence-panels"
import { VerificationFragmentPicker } from "./verification-fragment-picker"
import { VerificationRequirementEditor } from "./verification-requirement-editor"
import { VerificationResultPanel, type VerificationPanelBusy } from "./verification-result-panel"
import {
  activeTask, bidVerificationValue, buildComparisonSubmission, buildRequirementsSubmission, checkRequirementSet,
  comparisonRequirementSetOptions, defaultComparisonForm, defaultExternalRecordForm, defaultExtractionForm, defaultFieldForm,
  evidenceMaterial, fieldFormFromView, finishedTasks, materialUnavailableReason, mergeTaskRows, nextSubmissionOperation,
  parseTaskResultReference, recordFormFromRequirement, requirementSetValue, requirementSourceMaterial, shouldPollVerificationTasks,
  submissionInputSignature, taskHint, taskInputSignature, taskStageLabel, taskStateLabel, validateExternalRecordForm,
  validateFieldForm, verificationExportBaseName, verificationListItems, verificationTasksOnly, verificationPollIntervalMs,
  type ComparisonForm, type ExtractionForm, type ExternalRecordForm, type FieldForm, type SubmissionOperation,
} from "./verification-state"
import {
  browserVerificationDraftStorage, clearVerificationDraft, isVerificationDraftDirty,
  readVerificationDraft, writeVerificationDraft, type VerificationFormDraft,
} from "./verification-draft"
import { budgetDisplay, formatReviewTime, parseYuanToFen } from "./review-state"

type RequirementEditorState = {
  resultId?: string
  baseVersionId: string
  source: "machine" | "manual"
  value: RequirementSetValue
  baseValue: RequirementSetValue
}
type FieldPicker = { materialId: string; fragments: SnapshotFragment[]; loading: boolean; error: string }

/**
 * Project bid-verification workspace (round-five C4-UI).
 *
 * The manual path is first class: parsed tender materials → manual requirements
 * from snapshot fragments → server-owned requirement-set save → certificate
 * fields → deterministic comparison → two independent status columns →
 * external records/review/export. Machine candidate extraction
 * (`bid-requirements`) is offered when the server model and an admin-registered
 * model budget are configured; without a model the manual path still completes
 * the workflow. Every request is bound to this project instance, late responses
 * are rejected, and a read-only member never triggers a write.
 */
export function ProjectVerificationWorkspace({ project, active, canEdit, canManage, blocked, isCurrent, onAccessInvalid, onOpenDocuments, registry }: {
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
    const current = () => life.alive && isCurrent() && !life.blocked
    return {
      client: createVerificationsClient({
        projectId: project.id,
        isCurrent: current,
        canEdit: () => life.editable,
        canManage: () => life.manage,
        onAccessInvalid,
      }),
      materials: createProjectMaterialsClient({ projectId: project.id, isCurrent: current, onAccessInvalid }),
      isCurrent: current,
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
  const [materials, setMaterials] = useState<VerificationMaterial[]>([])
  const [tasks, setTasks] = useState<VerificationTaskView[]>([])
  const [summaries, setSummaries] = useState<VerificationListSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [taskError, setTaskError] = useState("")
  const [notice, setNotice] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [extractionForm, setExtractionForm] = useState<ExtractionForm>(defaultExtractionForm)
  const [extractionIssues, setExtractionIssues] = useState<string[]>([])
  const [extractionError, setExtractionError] = useState("")
  const [extractionBusy, setExtractionBusy] = useState(false)
  const [comparisonForm, setComparisonForm] = useState<ComparisonForm>(defaultComparisonForm)
  const [comparisonIssues, setComparisonIssues] = useState<string[]>([])
  const [comparisonError, setComparisonError] = useState("")
  const [comparisonBusy, setComparisonBusy] = useState(false)
  const [selectedResultId, setSelectedResultId] = useState("")
  const [detail, setDetail] = useState<VerificationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState("")
  const [detailReload, setDetailReload] = useState(0)
  const [editor, setEditor] = useState<RequirementEditorState | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState("")
  const [fieldMaterialId, setFieldMaterialId] = useState("")
  const [fields, setFields] = useState<VerificationFieldView[]>([])
  const [fieldHistory, setFieldHistory] = useState<VerificationFieldView[]>([])
  const [fieldsLoading, setFieldsLoading] = useState(false)
  const [fieldsError, setFieldsError] = useState("")
  const [fieldsReload, setFieldsReload] = useState(0)
  const [fieldForm, setFieldForm] = useState<FieldForm>(defaultFieldForm)
  const [fieldSourceFragment, setFieldSourceFragment] = useState<SnapshotFragment | null>(null)
  const [fieldFormIssues, setFieldFormIssues] = useState<string[]>([])
  const [fieldBusy, setFieldBusy] = useState(false)
  const [fieldSaveError, setFieldSaveError] = useState("")
  const [fieldPicker, setFieldPicker] = useState<FieldPicker | null>(null)
  const [recordForm, setRecordForm] = useState<ExternalRecordForm>(defaultExternalRecordForm)
  const [recordIssues, setRecordIssues] = useState<string[]>([])
  const [recordBusy, setRecordBusy] = useState(false)
  const [recordError, setRecordError] = useState("")
  const [validationOverride, setValidationOverride] = useState<Record<string, ResultValidation>>({})
  const [reviewComment, setReviewComment] = useState("")
  const [resultBusy, setResultBusy] = useState<VerificationPanelBusy>(null)
  const [resultError, setResultError] = useState("")
  const [exports, setExports] = useState<ExportRef[]>([])
  const [exportsError, setExportsError] = useState("")
  const [exportsVersion, setExportsVersion] = useState(0)
  const [budget, setBudget] = useState<ProjectBudgetView | null>(null)
  const [budgetLoaded, setBudgetLoaded] = useState(false)
  const [budgetError, setBudgetError] = useState("")
  const [budgetBusy, setBudgetBusy] = useState(false)
  const extractionOperation = useRef<SubmissionOperation | null>(null)
  const comparisonOperation = useRef<SubmissionOperation | null>(null)
  const editorOperation = useRef<{ signature: string; key: string } | null>(null)
  const fieldOperation = useRef<{ signature: string; key: string } | null>(null)
  const restored = useRef(false)
  const loadedOnce = useRef(false)

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

  const restoreDraftOnce = useCallback((materialRows: VerificationMaterial[]) => {
    if (restored.current) return
    restored.current = true
    const stored = readVerificationDraft(browserVerificationDraftStorage(), project.id)
    if (!stored) return
    const known = new Set(materialRows.map(material => material.id))
    setExtractionForm({ ...stored.extraction, materialIds: stored.extraction.materialIds.filter(id => known.has(id)) })
    setComparisonForm({ ...stored.comparison, materialIds: stored.comparison.materialIds.filter(id => known.has(id)), recordIds: [] })
    setFieldForm(stored.field)
    setFieldMaterialId(known.has(stored.fieldMaterialId) ? stored.fieldMaterialId : "")
    setRecordForm(stored.externalRecord)
  }, [project.id])

  useEffect(() => {
    if (!active || blocked || !visible) return
    const controller = new AbortController()
    void (async () => {
      if (!loadedOnce.current) setLoading(true)
      setLoadError("")
      try {
        const [materialRows, taskRows, summaryRows] = await Promise.all([
          runtime.client.listMaterials(controller.signal),
          runtime.client.listTasks(controller.signal),
          runtime.client.listVerifications(controller.signal),
        ])
        if (!current() || controller.signal.aborted) return
        loadedOnce.current = true
        setMaterials(materialRows)
        setTasks(verificationTasksOnly(taskRows))
        setSummaries(summaryRows)
        setTaskError("")
        restoreDraftOnce(materialRows)
      } catch (failure) {
        if (current() && !controller.signal.aborted) setLoadError(errorMessage(failure))
      } finally {
        if (current() && !controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [active, blocked, visible, reloadToken, runtime, current, restoreDraftOnce])

  useEffect(() => {
    if (!active || blocked || !canManage) return
    const controller = new AbortController()
    void (async () => {
      try {
        const value = await runtime.client.getBudget(controller.signal)
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
  }, [active, blocked, canManage, runtime, current, reloadToken])

  useEffect(() => {
    if (!selectedResultId || !active || blocked) return
    const controller = new AbortController()
    void (async () => {
      setDetailLoading(true)
      setDetail(null)
      setDetailError("")
      try {
        const value = await runtime.client.getVerification(selectedResultId, controller.signal)
        if (!current() || controller.signal.aborted) return
        setDetail(value)
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          setDetail(null)
          setDetailError(errorMessage(failure))
        }
      } finally {
        if (current() && !controller.signal.aborted) setDetailLoading(false)
      }
    })()
    return () => controller.abort()
  }, [selectedResultId, detailReload, active, blocked, runtime, current])

  useEffect(() => {
    if (!fieldMaterialId) return
    const material = materials.find(item => item.id === fieldMaterialId)
    if (!material) return
    const controller = new AbortController()
    void (async () => {
      setFieldsLoading(true)
      setFieldsError("")
      try {
        const value = await runtime.client.listFields(material.id, material.versionId, controller.signal)
        if (!current() || controller.signal.aborted) return
        setFields(value.fields)
        setFieldHistory(value.history)
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          setFields([])
          setFieldHistory([])
          setFieldsError(errorMessage(failure))
        }
      } finally {
        if (current() && !controller.signal.aborted) setFieldsLoading(false)
      }
    })()
    return () => controller.abort()
  }, [fieldMaterialId, fieldsReload, materials, runtime, current])

  const selectedResultKind = detail?.result.kind ?? summaries.find(item => item.resultId === selectedResultId)?.kind ?? ""
  const selectedResultVersion = detail?.result.versionId ?? ""
  useEffect(() => {
    if (!selectedResultId || selectedResultKind !== "bid-verification") return
    const controller = new AbortController()
    void (async () => {
      try {
        const rows = await runtime.client.listExports(selectedResultId, controller.signal)
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
  }, [selectedResultId, selectedResultKind, selectedResultVersion, exportsVersion, runtime, current])

  const poll = useCallback(async () => {
    if (!current()) return
    const controller = beginAction()
    try {
      const activeRows = tasks.filter(activeTask)
      const details = await Promise.all(activeRows.map(task => runtime.client.getTask(task.id, controller.signal)))
      if (!current() || controller.signal.aborted) return
      const before = tasks
      let merged = before
      for (const updated of details) merged = mergeTaskRows(merged, updated)
      setTasks(merged)
      setTaskError("")
      if (finishedTasks(before, merged).length) {
        setReloadToken(value => value + 1)
        setDetailReload(value => value + 1)
        setNotice("核验任务已结束，任务与成果已刷新。")
      }
    } catch (failure) {
      if (!current() || controller.signal.aborted) return
      setTaskError(errorMessage(failure))
    } finally {
      endAction(controller)
    }
  }, [tasks, runtime, current, beginAction, endAction])

  useEffect(() => {
    if (!active || blocked || !visible) return
    if (!shouldPollVerificationTasks(tasks)) return
    const timer = setTimeout(() => void poll(), verificationPollIntervalMs)
    return () => clearTimeout(timer)
  }, [active, blocked, visible, tasks, poll])

  const formsDraft = useMemo<VerificationFormDraft>(() => ({
    version: 1,
    extraction: extractionForm,
    comparison: comparisonForm,
    field: fieldForm,
    externalRecord: recordForm,
    fieldMaterialId,
  }), [comparisonForm, extractionForm, fieldForm, fieldMaterialId, recordForm])
  const formsDirty = isVerificationDraftDirty(formsDraft)
  const requirementDirty = Boolean(editor && JSON.stringify(editor.value) !== JSON.stringify(editor.baseValue))
  const editorTargetValue = editor?.value

  const saveRequirementDraft = useCallback(async (valueOverride?: RequirementSetValue): Promise<boolean> => {
    if (!editor) return true
    const target = valueOverride ?? editor.value
    if (!canEdit) return false
    const checked = checkRequirementSet(target)
    if (checked.issues.length) { setEditorError(checked.issues[0] ?? "要求集未通过保存前检查。"); return false }
    const signature = JSON.stringify({ resultId: editor.resultId ?? "", baseVersionId: editor.baseVersionId, value: target })
    const operation = editorOperation.current?.signature === signature ? editorOperation.current : { signature, key: crypto.randomUUID() }
    editorOperation.current = operation
    setEditorBusy(true)
    setEditorError("")
    const controller = beginAction()
    try {
      const saved = await runtime.client.saveRequirementSet({
        ...(editor.resultId ? { resultId: editor.resultId } : {}),
        baseVersionId: editor.baseVersionId,
        operationId: operation.key,
        reason: editor.source === "machine" ? "人工确认/更正投标要求候选" : "人工录入投标要求集",
        value: target,
      }, controller.signal)
      if (!current() || controller.signal.aborted) return false
      editorOperation.current = null
      const decoded = requirementSetValue(saved.value) ?? target
      setEditor({ resultId: saved.resultId, baseVersionId: saved.versionId, source: "manual", value: decoded, baseValue: decoded })
      setSelectedResultId(saved.resultId)
      setReloadToken(token => token + 1)
      setDetailReload(token => token + 1)
      setNotice("要求集已保存为新版本。")
      return true
    } catch (failure) {
      if (current() && !controller.signal.aborted) setEditorError(errorMessage(failure))
      return false
    } finally {
      endAction(controller)
      if (current()) setEditorBusy(false)
    }
  }, [editor, canEdit, runtime, current, beginAction, endAction])

  useEffect(() => {
    if (!canEdit || blocked) return
    if (!requirementDirty || !editor || !editorTargetValue) return
    return registry.register({
      id: `verification-requirements:${project.id}`,
      label: "要求集编辑",
      save: () => saveRequirementDraft(editorTargetValue),
      discard() { setEditor(currentEditor => currentEditor ? { ...currentEditor, value: currentEditor.baseValue } : currentEditor) },
    })
  }, [canEdit, blocked, requirementDirty, editor, editorTargetValue, project.id, registry, saveRequirementDraft])

  useEffect(() => {
    if (!canEdit || blocked || !formsDirty) return
    return registry.register({
      id: `verification-draft:${project.id}`,
      label: "核验输入",
      save: async () => {
        try { return writeVerificationDraft(browserVerificationDraftStorage(), project.id, formsDraft) } catch { return false }
      },
      discard() {
        clearVerificationDraft(browserVerificationDraftStorage(), project.id)
        setExtractionForm(defaultExtractionForm())
        setComparisonForm(defaultComparisonForm())
        setFieldForm(defaultFieldForm())
        setFieldMaterialId("")
        setFieldSourceFragment(null)
        setRecordForm(defaultExternalRecordForm())
      },
    })
  }, [canEdit, blocked, formsDirty, formsDraft, project.id, registry])

  useEffect(() => {
    if (!requirementDirty && !formsDirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [requirementDirty, formsDirty])

  const extractionSubmission = buildRequirementsSubmission(extractionForm, materials)
  const extractionSignature = extractionSubmission.submission
    ? submissionInputSignature("bid-requirements", extractionSubmission.submission.refs, extractionSubmission.submission.conditions)
    : null
  const activeExtraction = extractionSignature !== null && tasks.some(task => activeTask(task) && taskInputSignature(task) === extractionSignature)
  const requirementSets = verificationListItems(summaries, "bid-requirements")
  const comparisons = verificationListItems(summaries, "bid-verification")
  const confirmedSets = comparisonRequirementSetOptions(summaries)
  const selectedSetSummary = confirmedSets.find(item => item.resultId === comparisonForm.requirementSetResultId) ?? null
  const comparisonDetailValue = detail && detail.result.kind === "bid-verification" ? bidVerificationValue(detail.result.value) : null
  const availableRecords = comparisonDetailValue && selectedSetSummary && comparisonDetailValue.requirementSet.versionId === selectedSetSummary.versionId ? detail?.records ?? [] : []
  const comparisonRequirements = comparisonDetailValue?.requirementSet.requirements ?? []
  const selectedResult = detail?.result ?? null
  const selectedValidation = selectedResult ? validationOverride[`${selectedResult.resultId}:${selectedResult.versionId}`] ?? selectedResult.validation : null
  const selectedMaterial = materials.find(material => material.id === fieldMaterialId) ?? null
  const budgetMissingForExtraction = canManage && budgetLoaded && !budget

  function refreshAll() {
    if (blocked) return
    setReloadToken(value => value + 1)
    setDetailReload(value => value + 1)
    setExportsVersion(value => value + 1)
    setFieldsReload(value => value + 1)
  }

  function updateExtraction(next: ExtractionForm) { setExtractionForm(next); setExtractionIssues([]); setExtractionError("") }
  function updateComparison(next: ComparisonForm) { setComparisonForm(next); setComparisonIssues([]); setComparisonError("") }

  async function submitExtraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || blocked || extractionBusy) return
    const built = buildRequirementsSubmission(extractionForm, materials)
    const issues = [...built.issues]
    if (budgetMissingForExtraction) issues.push("请先登记模型调用预算。")
    if (issues.length) { setExtractionIssues(issues); return }
    if (!built.submission) return
    const signature = submissionInputSignature("bid-requirements", built.submission.refs, built.submission.conditions)
    if (tasks.some(task => activeTask(task) && taskInputSignature(task) === signature)) { setExtractionIssues(["相同输入的要求候选任务正在进行。"]); return }
    const operation = nextSubmissionOperation(extractionOperation.current, signature, () => crypto.randomUUID())
    extractionOperation.current = operation
    setExtractionIssues([]); setExtractionError(""); setExtractionBusy(true)
    const controller = beginAction()
    try {
      const created = await runtime.client.submitTask(built.submission, operation.key, controller.signal)
      if (!current() || controller.signal.aborted) return
      extractionOperation.current = null
      setTasks(rows => mergeTaskRows(rows, created.task))
      setExtractionForm(defaultExtractionForm())
      clearVerificationDraft(browserVerificationDraftStorage(), project.id)
      setNotice(created.created ? "要求候选任务已提交。" : "该输入已有要求候选任务，已保留原任务。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setExtractionError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setExtractionBusy(false)
    }
  }

  async function submitComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || blocked || comparisonBusy) return
    const setSummary = confirmedSets.find(item => item.resultId === comparisonForm.requirementSetResultId) ?? null
    const requirementSet = setSummary ? { id: setSummary.resultId, versionId: setSummary.versionId, sha256: setSummary.sha256 } : null
    const built = buildComparisonSubmission(comparisonForm, materials, requirementSet, availableRecords)
    if (built.issues.length) { setComparisonIssues(built.issues); return }
    if (!built.submission) return
    const signature = submissionInputSignature("bid-verification", built.submission.refs, built.submission.conditions)
    if (tasks.some(task => activeTask(task) && taskInputSignature(task) === signature)) { setComparisonIssues(["相同输入的比较任务正在进行。"]); return }
    const operation = nextSubmissionOperation(comparisonOperation.current, signature, () => crypto.randomUUID())
    comparisonOperation.current = operation
    setComparisonIssues([]); setComparisonError(""); setComparisonBusy(true)
    const controller = beginAction()
    try {
      const created = await runtime.client.submitTask(built.submission, operation.key, controller.signal)
      if (!current() || controller.signal.aborted) return
      comparisonOperation.current = null
      setTasks(rows => mergeTaskRows(rows, created.task))
      setNotice(created.created ? "比较任务已提交。" : "该输入已有比较任务，已保留原任务。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setComparisonError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setComparisonBusy(false)
    }
  }

  async function openRequirementEditor(resultId: string | null, source: "machine" | "manual") {
    setEditorError("")
    if (resultId) {
      try {
        const value = await runtime.client.getVerification(resultId, undefined)
        if (!current()) return
        const decoded = requirementSetValue(value.result.value)
        if (!decoded) { setNotice("要求集内容无法读取，请刷新后重试。"); return }
        setEditor({ resultId, baseVersionId: value.result.versionId, source, value: decoded, baseValue: decoded })
        setSelectedResultId(resultId)
      } catch (failure) {
        if (current()) setNotice(errorMessage(failure))
      }
      return
    }
    const empty: RequirementSetValue = { schemaVersion: 1, status: "candidate", requirements: [], rejected: [], warnings: [], errors: [] }
    setEditor({ baseVersionId: "", source, value: empty, baseValue: empty })
  }

  async function openFieldPicker() {
    const material = materials.find(item => item.id === fieldMaterialId)
    if (!material?.snapshotId) return
    setFieldPicker({ materialId: material.id, fragments: [], loading: true, error: "" })
    const controller = beginAction()
    try {
      const read = await runtime.materials.snapshot(material.id, material.snapshotId, controller.signal)
      if (!current() || controller.signal.aborted) return
      setFieldPicker(picker => picker && picker.materialId === material.id ? { ...picker, fragments: read.fragments, loading: false } : picker)
    } catch (failure) {
      if (current() && !controller.signal.aborted) {
        setFieldPicker(picker => picker ? { ...picker, loading: false, error: errorMessage(failure) } : picker)
      }
    } finally {
      endAction(controller)
    }
  }

  async function submitField() {
    if (!canEdit || !fieldMaterialId || fieldBusy) return
    const material = materials.find(item => item.id === fieldMaterialId)
    if (!material) return
    const checked = validateFieldForm(fieldForm, { fields, fragmentText: fieldSourceFragment?.text ?? null })
    if (!checked.ready || !checked.write) { setFieldFormIssues(checked.issues); return }
    setFieldFormIssues([]); setFieldSaveError(""); setFieldBusy(true)
    const signature = JSON.stringify({ materialId: material.id, versionId: material.versionId, write: checked.write, reason: checked.reason })
    const operation = fieldOperation.current?.signature === signature ? fieldOperation.current : { signature, key: crypto.randomUUID() }
    fieldOperation.current = operation
    const controller = beginAction()
    try {
      await runtime.client.registerFields(material.id, material.versionId, {
        operationId: operation.key,
        ...(checked.reason ? { reason: checked.reason } : {}),
        fields: [checked.write],
      }, controller.signal)
      if (!current() || controller.signal.aborted) return
      fieldOperation.current = null
      const value = await runtime.client.listFields(material.id, material.versionId, controller.signal)
      if (!current() || controller.signal.aborted) return
      setFields(value.fields)
      setFieldHistory(value.history)
      setFieldForm({ ...defaultFieldForm(), fieldKey: fieldForm.fieldKey, subjectKey: fieldForm.subjectKey })
      setFieldSourceFragment(null)
      setNotice("证照字段已保存；原值保留在更正历史中。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setFieldSaveError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setFieldBusy(false)
    }
  }

  async function submitRecord() {
    if (!canEdit || !detail || recordBusy) return
    const comparison = bidVerificationValue(detail.result.value)
    const requirementIds = new Set(comparison?.requirementSet.requirements.map(requirement => requirement.requirementId) ?? [])
    const proofVersionIds = new Set(materials.filter(evidenceMaterial).map(material => material.versionId))
    const checked = validateExternalRecordForm(recordForm, { requirementIds, proofVersionIds })
    if (!checked.ready || !checked.value) { setRecordIssues(checked.issues); return }
    setRecordIssues([]); setRecordError(""); setRecordBusy(true)
    const controller = beginAction()
    try {
      await runtime.client.appendExternalRecord(detail.result.resultId, {
        versionId: detail.result.versionId,
        sha256: detail.result.sha256,
        ...checked.value,
      }, controller.signal)
      if (!current() || controller.signal.aborted) return
      setRecordForm(defaultExternalRecordForm())
      setDetailReload(value => value + 1)
      setNotice("外部核验记录已追加；重新运行比较后才会进入新成果的外部真实性状态。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setRecordError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setRecordBusy(false)
    }
  }

  function changeRecordRequirement(requirementId: string) {
    if (!detail) { setRecordForm({ ...recordForm, requirementId }); return }
    const comparison = bidVerificationValue(detail.result.value)
    const requirement = comparison?.requirementSet.requirements.find(item => item.requirementId === requirementId)
    const item = comparison?.items.find(entry => entry.requirementId === requirementId)
    if (requirement && item) setRecordForm(recordFormFromRequirement(requirement, item.evidence))
    else setRecordForm({ ...recordForm, requirementId })
    setRecordIssues([])
  }

  async function runResultAction(kind: VerificationPanelBusy, work: (controller: AbortController) => Promise<void>) {
    if (resultBusy) return
    const controller = beginAction()
    setResultBusy(kind)
    setResultError("")
    try {
      await work(controller)
    } catch (failure) {
      if (current() && !controller.signal.aborted) setResultError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setResultBusy(null)
    }
  }

  function validateSelected(result: VerificationResultView) {
    void runResultAction("validate", async controller => {
      const checked = await runtime.client.validateResult({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256 }, controller.signal)
      if (!current()) return
      setValidationOverride(rows => ({ ...rows, [`${result.resultId}:${result.versionId}`]: checked }))
    })
  }

  function reviewSelected(result: VerificationResultView, decision: ResultReview["decision"]) {
    const comment = reviewComment.trim()
    if (decision === "rejected" && !comment) { setResultError("驳回需填写复核意见。"); return }
    void runResultAction("review", async controller => {
      const updated = await runtime.client.reviewResult({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256, decision, comment }, controller.signal)
      if (!current()) return
      setDetail(currentDetail => currentDetail ? { ...currentDetail, result: updated } : currentDetail)
      setReloadToken(value => value + 1)
      setNotice("复核记录已保存。")
    })
  }

  function createExport(result: VerificationResultView) {
    void runResultAction("export", async controller => {
      const created = await runtime.client.createExport({ resultId: result.resultId, versionId: result.versionId, sha256: result.sha256 }, controller.signal)
      if (!current()) return
      setExportsVersion(value => value + 1)
      setExports(rows => [created, ...rows.filter(row => row.exportId !== created.exportId)])
      const blob = await runtime.client.downloadExport(result.resultId, created.exportId, controller.signal)
      if (!current()) return
      downloadDocument(blob, verificationExportBaseName())
    })
  }

  async function downloadExport(result: VerificationResultView, exportRef: ExportRef) {
    const controller = beginAction()
    setResultBusy("download")
    setExportsError("")
    try {
      const blob = await runtime.client.downloadExport(result.resultId, exportRef.exportId, controller.signal)
      if (!current()) return
      downloadDocument(blob, verificationExportBaseName())
    } catch (failure) {
      if (current() && !controller.signal.aborted) setExportsError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setResultBusy(null)
    }
  }

  async function registerBudget(fen: number): Promise<boolean> {
    if (!canManage || budgetBusy) return false
    setBudgetBusy(true)
    setBudgetError("")
    const controller = beginAction()
    try {
      const value = await runtime.client.registerBudget(fen, controller.signal)
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

  return <div className="flex flex-col gap-6">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">投标材料核验</h2>{!canEdit && <Badge variant="outline">只读成员</Badge>}</div>
      <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={refreshAll}><RefreshCwIcon />刷新</Button>
    </header>
    {!canEdit && <p role="note" className="text-sm text-muted-foreground">只读成员可查看材料、任务与成果，不能提交任务、保存要求集、登记字段或导出。</p>}
    {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">状态获取失败：{loadError}</p><Button type="button" variant="outline" onClick={() => setReloadToken(value => value + 1)}>重试</Button></div>}
    {taskError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">任务状态获取失败：{taskError}</p><Button type="button" variant="outline" onClick={() => setReloadToken(value => value + 1)}>重试</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}

    <section aria-label="项目材料" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">项目材料</h3><Button type="button" variant="outline" size="sm" onClick={onOpenDocuments}>前往文档</Button></div>
      {materials.length === 0 && !loading ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>暂无核验材料</EmptyTitle></EmptyHeader><Button type="button" variant="outline" onClick={onOpenDocuments}>前往文档上传资料</Button></Empty> : materials.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>材料</TableHead><TableHead>格式</TableHead><TableHead>解析状态</TableHead><TableHead>覆盖范围 / 可用性</TableHead><TableHead>用途</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {materials.map(material => <TableRow key={material.id}>
          <TableCell className="whitespace-normal">{material.title}</TableCell>
          <TableCell>{material.format.toUpperCase()}</TableCell>
          <TableCell>{material.parseState ? taskStateLabel(material.parseState) : material.format === "image" ? "证照图片" : "无解析任务"}</TableCell>
          <TableCell className="whitespace-normal">{material.coverage ? <span>{material.coverage.status === "available" ? "已覆盖" : material.coverage.status === "partial" ? "部分覆盖" : "解析失败"} · {material.coverage.textLength} 字符</span> : material.format === "image" ? "由 OCR 字段表示" : materialUnavailableReason(material)}</TableCell>
          <TableCell className="whitespace-normal"><div className="flex flex-wrap gap-1">{requirementSourceMaterial(material) && <Badge variant="outline">要求来源</Badge>}{evidenceMaterial(material) && <Badge variant="outline">字段/比较</Badge>}</div></TableCell>
          <TableCell><Button type="button" variant="link" size="sm" onClick={() => { setFieldMaterialId(material.id); setFields([]); setFieldHistory([]); setFieldForm(defaultFieldForm()); setFieldSourceFragment(null); setFieldsError("") }}>证照字段</Button></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
      {selectedMaterial && <VerificationFieldPanel
        materials={materials}
        materialId={fieldMaterialId}
        onMaterialChange={id => { setFieldMaterialId(id); setFields([]); setFieldHistory([]); setFieldSourceFragment(null); setFieldForm(defaultFieldForm()); setFieldsError("") }}
        fields={fields}
        history={fieldHistory}
        loading={fieldsLoading}
        error={fieldsError}
        canEdit={canEdit}
        busy={fieldBusy}
        form={fieldForm}
        onFormChange={form => { setFieldForm(form); setFieldFormIssues([]); setFieldSaveError("") }}
        onSubmit={() => void submitField()}
        formIssues={fieldFormIssues}
        sourceFragment={fieldSourceFragment}
        sourceFragmentError={fieldPicker?.error ?? fieldSaveError}
        onPickSourceFragment={() => void openFieldPicker()}
        onClearSourceFragment={() => setFieldForm({ ...fieldForm, sourceFragmentId: "" })}
        onCorrect={view => { setFieldForm(fieldFormFromView(view)); setFieldFormIssues([]) }}
        onRefresh={() => setFieldsReload(value => value + 1)}
      />}
      {!selectedMaterial && canEdit && <p className="text-sm text-muted-foreground">选择材料版本后可读取、登记或更正证照字段。</p>}
    </section>

    <section aria-label="要求集与比较" className="flex flex-col gap-4">
      <h3 className="text-base font-semibold">要求集与比较</h3>
      {canEdit && <form aria-label="提取要求候选" className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={event => void submitExtraction(event)}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">要求候选提取</p><Button type="button" variant="outline" size="sm" onClick={() => void openRequirementEditor(null, "manual")}>新建手工要求集</Button></div>
        <p className="text-xs text-muted-foreground">选择已解析的招标、澄清或补遗材料，由模型提出要求候选；候选必须人工确认后才能用于比较。</p>
        {materials.filter(requirementSourceMaterial).length === 0 ? <p role="status" className="text-sm text-muted-foreground">暂无可用于提取要求的已解析材料</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>选择</TableHead><TableHead>材料</TableHead><TableHead>解析覆盖</TableHead></TableRow></TableHeader><TableBody>
          {materials.filter(requirementSourceMaterial).map(material => {
            const checked = extractionForm.materialIds.includes(material.id)
            return <TableRow key={material.id}>
              <TableCell><input type="checkbox" aria-label={`选择 ${material.title} 提取要求`} checked={checked} disabled={extractionBusy || (!checked && extractionForm.materialIds.length >= 10)} onChange={() => updateExtraction({ ...extractionForm, materialIds: checked ? extractionForm.materialIds.filter(id => id !== material.id) : [...extractionForm.materialIds, material.id] })} /></TableCell>
              <TableCell className="whitespace-normal">{material.title}</TableCell>
              <TableCell>{material.coverage?.status === "available" ? "已覆盖" : material.coverage?.status === "partial" ? "部分覆盖（结果将标注范围限制）" : "未知"}</TableCell>
            </TableRow>
          })}
        </TableBody></Table></div>}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 text-sm">判定日期（可选）<Input type="date" value={extractionForm.asOf} disabled={extractionBusy} onChange={event => updateExtraction({ ...extractionForm, asOf: event.target.value })} /></label>
          <label className="flex items-start gap-2 pt-7 text-sm"><input type="checkbox" checked={extractionForm.consent} disabled={extractionBusy} onChange={event => updateExtraction({ ...extractionForm, consent: event.target.checked })} /><span>我同意将所选材料发送给第三方模型服务，用于提取要求候选。</span></label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={extractionBusy || activeExtraction}>{extractionBusy ? "正在提交" : activeExtraction ? "相同任务正在进行" : "提取要求候选"}</Button>
          {budgetMissingForExtraction && <span className="text-xs text-muted-foreground">请先登记模型调用预算。</span>}
        </div>
        {extractionIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{extractionIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        {extractionError && <p role="alert" className="text-sm text-destructive">{extractionError}</p>}
      </form>}
      {canEdit && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-4">
        <p className="text-sm font-medium">模型调用预算</p>
        {canManage
          ? budgetError ? <p role="alert" className="text-sm text-destructive">预算读取失败：{budgetError}</p>
            : !budgetLoaded ? <p role="status" className="text-sm">正在读取预算</p>
              : <><span className="text-sm">{budget ? `上限 ${budgetDisplay(budget).limit} · 已预留与已用 ${budgetDisplay(budget).committed} · 剩余 ${budgetDisplay(budget).remaining}` : "尚未登记模型调用预算"}</span><VerificationBudgetSheet budget={budget} busy={budgetBusy} error={budgetError} onRegister={registerBudget} /></>
          : <span className="text-sm text-muted-foreground">要求候选提取需要项目管理员登记模型调用预算；未登记时任务将因预算缺失失败。</span>}
      </div>}

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">要求集</p><span className="text-xs text-muted-foreground">只有全部确认且校验通过的要求集可用于比较</span></div>
        {requirementSets.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><ShieldCheckIcon /></EmptyMedia><EmptyTitle>暂无要求集</EmptyTitle></EmptyHeader></Empty> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>状态</TableHead><TableHead>要求数</TableHead><TableHead>待确认</TableHead><TableHead>校验</TableHead><TableHead>复核</TableHead><TableHead>生成时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {requirementSets.map(item => <TableRow key={item.resultId}>
            <TableCell>{item.summary.status === "confirmed" ? "已确认" : "候选"}</TableCell>
            <TableCell>{item.summary.requirementCount}</TableCell>
            <TableCell>{item.summary.pendingCount ?? "—"}</TableCell>
            <TableCell>{item.validation.status === "valid" ? "通过" : item.validation.status === "partial" ? "待确认" : "未通过"}</TableCell>
            <TableCell>{item.review?.decision === "approved" ? "已批准" : item.review?.decision === "rejected" ? "已驳回" : "待复核"}</TableCell>
            <TableCell className="whitespace-normal">{formatReviewTime(item.createdAt)}</TableCell>
            <TableCell><div className="flex flex-wrap gap-2"><Button type="button" variant="link" size="sm" onClick={() => { setResultError(""); setSelectedResultId(item.resultId); setDetailReload(value => value + 1) }}>查看</Button>{canEdit && <Button type="button" variant="link" size="sm" onClick={() => void openRequirementEditor(item.resultId, "machine")}>编辑</Button>}</div></TableCell>
          </TableRow>)}
        </TableBody></Table></div>}
      </div>

      {canEdit && <form aria-label="运行材料比较" className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={event => void submitComparison(event)}>
        <p className="text-sm font-medium">运行材料比较</p>
        <p className="text-xs text-muted-foreground">由服务端确定性比较已确认要求集与材料字段，不调用模型；判定日期必须明确填写。</p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 text-sm">要求集<NativeSelect value={comparisonForm.requirementSetResultId} disabled={comparisonBusy} onChange={event => updateComparison({ ...comparisonForm, requirementSetResultId: event.target.value, recordIds: [] })}><NativeSelectOption value="">请选择已确认要求集</NativeSelectOption>{confirmedSets.map(item => <NativeSelectOption key={item.resultId} value={item.resultId}>{formatReviewTime(item.createdAt)} · {item.summary.requirementCount} 条</NativeSelectOption>)}</NativeSelect></label>
          <label className="grid gap-2 text-sm">判定日期<Input type="date" value={comparisonForm.asOf} disabled={comparisonBusy} onChange={event => updateComparison({ ...comparisonForm, asOf: event.target.value })} /></label>
        </div>
        <div className="space-y-2">
          <p className="text-sm">比较材料</p>
          {materials.filter(evidenceMaterial).length === 0 ? <p role="status" className="text-sm text-muted-foreground">暂无可用于比较的材料版本</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>选择</TableHead><TableHead>材料</TableHead><TableHead>字段来源</TableHead></TableRow></TableHeader><TableBody>
            {materials.filter(evidenceMaterial).map(material => {
              const checked = comparisonForm.materialIds.includes(material.id)
              return <TableRow key={material.id}>
                <TableCell><input type="checkbox" aria-label={`选择 ${material.title} 参与比较`} checked={checked} disabled={comparisonBusy || (!checked && comparisonForm.materialIds.length >= 10)} onChange={() => updateComparison({ ...comparisonForm, materialIds: checked ? comparisonForm.materialIds.filter(id => id !== material.id) : [...comparisonForm.materialIds, material.id] })} /></TableCell>
                <TableCell className="whitespace-normal">{material.title}</TableCell>
                <TableCell>{material.format === "image" ? "OCR 识别字段" : material.snapshotId ? "人工登记 / OCR 字段" : "暂无字段"}</TableCell>
              </TableRow>
            })}
          </TableBody></Table></div>}
        </div>
        <div className="space-y-2">
          <p className="text-sm">引用外部核验记录</p>
          {availableRecords.length === 0 ? <p role="status" className="text-sm text-muted-foreground">暂无可引用的外部核验记录；可先运行一次比较并在成果详情中登记记录。</p> : <div className="space-y-1">{availableRecords.map(record => <label key={record.recordId} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={comparisonForm.recordIds.includes(record.recordId)} disabled={comparisonBusy} onChange={() => updateComparison({ ...comparisonForm, recordIds: comparisonForm.recordIds.includes(record.recordId) ? comparisonForm.recordIds.filter(id => id !== record.recordId) : [...comparisonForm.recordIds, record.recordId] })} /><span>{record.requirementId} · {record.source} · {record.queriedAt} · {record.conclusion === "matched" ? "记录匹配" : record.conclusion}</span></label>)}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={comparisonBusy}>{comparisonBusy ? "正在提交" : "运行比较"}</Button></div>
        {comparisonIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{comparisonIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        {comparisonError && <p role="alert" className="text-sm text-destructive">{comparisonError}</p>}
      </form>}
    </section>

    <section aria-label="核验任务" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">核验任务</h3>
      {tasks.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><LoaderCircleIcon /></EmptyMedia><EmptyTitle>暂无核验任务</EmptyTitle></EmptyHeader></Empty> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>状态</TableHead><TableHead>阶段</TableHead><TableHead>调用次数</TableHead><TableHead>提交时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {tasks.map(task => {
          const reference = parseTaskResultReference(task.resultSummary)
          return <TableRow key={task.id}>
            <TableCell>{task.kind === "bid-requirements" ? "要求候选" : "材料比较"}</TableCell>
            <TableCell><Badge variant={task.state === "failed" ? "destructive" : "outline"}>{taskStateLabel(task.state)}</Badge>{task.error && <p role="alert" className="text-xs text-destructive">{task.error.message}</p>}</TableCell>
            <TableCell>{taskStageLabel(task)}</TableCell>
            <TableCell>{task.callsUsed} / {task.maxCalls}</TableCell>
            <TableCell className="whitespace-normal">{formatReviewTime(task.createdAt)}</TableCell>
            <TableCell>{reference ? <Button type="button" variant="link" size="sm" onClick={() => { setResultError(""); setSelectedResultId(reference.resultId); setDetailReload(value => value + 1) }}>打开成果</Button> : activeTask(task) ? <span className="text-xs text-muted-foreground">{taskHint(task)}</span> : "—"}</TableCell>
          </TableRow>
        })}
      </TableBody></Table></div>}
      {tasks.some(activeTask) && <p role="status" className="text-sm text-muted-foreground">任务处理中，页面每 5 秒读取持久任务状态，终态后停止。</p>}
    </section>

    <section aria-label="核验成果" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">核验成果</h3>
      {summaries.length === 0 && !loading ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><ShieldCheckIcon /></EmptyMedia><EmptyTitle>暂无核验成果</EmptyTitle></EmptyHeader></Empty> : summaries.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>摘要</TableHead><TableHead>校验</TableHead><TableHead>复核</TableHead><TableHead>更新提示</TableHead><TableHead>生成时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {[...requirementSets, ...comparisons].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(item => <TableRow key={item.resultId}>
          <TableCell>{item.kind === "bid-requirements" ? "要求集" : "核验结果"}</TableCell>
          <TableCell className="max-w-md whitespace-normal">{item.kind === "bid-requirements" ? `${item.summary.status === "confirmed" ? "已确认" : "候选"} · ${item.summary.requirementCount} 条${item.summary.pendingCount !== undefined ? ` · 待确认 ${item.summary.pendingCount}` : ""}` : `要求 ${item.summary.requirementCount} 项 · 材料满足 ${item.summary.materialSatisfied ?? 0} 项 · 外部匹配 ${item.summary.externalMatched ?? 0} 项 · 未完成 ${item.summary.unfinished ?? 0} 项`}</TableCell>
          <TableCell>{item.validation.status === "valid" ? "通过" : item.validation.status === "partial" ? "待确认" : "未通过"}</TableCell>
          <TableCell>{item.review?.decision === "approved" ? "已批准" : item.review?.decision === "rejected" ? "已驳回" : item.review?.decision === "changes_requested" ? "退回修改" : "待复核"}</TableCell>
          <TableCell className="whitespace-normal">{item.stale.hint ?? ""}</TableCell>
          <TableCell className="whitespace-normal">{formatReviewTime(item.createdAt)}</TableCell>
          <TableCell><Button type="button" variant={selectedResultId === item.resultId ? "secondary" : "link"} size="sm" disabled={detailLoading && selectedResultId === item.resultId} onClick={() => { setResultError(""); setSelectedResultId(item.resultId); setDetailReload(value => value + 1) }}>查看</Button></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
      {detailError && <p role="alert" className="text-sm text-destructive">成果读取失败：{detailError}</p>}
      {detailLoading && <p role="status" className="text-sm text-muted-foreground">正在读取核验成果</p>}
    </section>

    {editor ? <VerificationRequirementEditor
      value={editor.value}
      materials={materials}
      source={editor.source}
      canEdit={canEdit}
      busy={editorBusy}
      error={editorError}
      isCurrent={current}
      onChange={value => { setEditor(currentEditor => currentEditor ? { ...currentEditor, value } : currentEditor); setEditorError("") }}
      onSave={value => { setEditor(currentEditor => currentEditor ? { ...currentEditor, value } : currentEditor); void saveRequirementDraft(value) }}
      onClose={() => { setEditor(null); setEditorError("") }}
      loadSnapshot={async material => {
        if (!material.snapshotId) return null
        try { return await runtime.materials.snapshot(material.id, material.snapshotId) } catch { return null }
      }}
    /> : selectedResult && selectedValidation && <VerificationResultPanel
      result={selectedResult}
      detail={detail}
      materials={materials}
      canEdit={canEdit}
      busy={resultBusy}
      error={resultError}
      validation={selectedValidation}
      reviewComment={reviewComment}
      onReviewCommentChange={setReviewComment}
      onValidate={() => validateSelected(selectedResult)}
      onReview={decision => reviewSelected(selectedResult, decision)}
      onCreateExport={() => createExport(selectedResult)}
      onDownloadExport={exportRef => void downloadExport(selectedResult, exportRef)}
      onEditRequirements={value => { setEditor({ resultId: selectedResult.resultId, baseVersionId: selectedResult.versionId, source: "machine", value, baseValue: value }); setEditorError("") }}
      onRefresh={() => { setDetailReload(value => value + 1); setReloadToken(value => value + 1) }}
      exports={exports}
      exportsError={exportsError}
    />}

    {selectedResult && selectedResult.kind === "bid-verification" && detail && comparisonDetailValue && <VerificationRecordPanel
      canEdit={canEdit}
      busy={recordBusy}
      error={recordError}
      records={detail.records}
      requirements={comparisonRequirements}
      form={recordForm}
      onFormChange={form => { setRecordForm(form); setRecordIssues([]); setRecordError("") }}
      onRequirementChange={changeRecordRequirement}
      onSubmit={() => void submitRecord()}
      formIssues={recordIssues}
      materials={materials}
      staleHintText={detail.stale.hint ?? ""}
      onRefresh={() => setDetailReload(value => value + 1)}
    />}

    <VerificationFragmentPicker
      open={fieldPicker !== null}
      onOpenChange={open => { if (!open) setFieldPicker(null) }}
      title="选择字段来源片段"
      fragments={fieldPicker?.fragments ?? []}
      loading={fieldPicker?.loading ?? false}
      error={fieldPicker?.error ?? ""}
      onSelect={fragment => {
        if (!fieldPicker) return
        setFieldForm(form => ({ ...form, sourceFragmentId: fragment.id }))
        setFieldSourceFragment(fragment)
        setFieldPicker(null)
      }}
    />
  </div>
}

function VerificationBudgetSheet({ budget, busy, error, onRegister }: { budget: ProjectBudgetView | null; busy: boolean; error: string; onRegister(fen: number): Promise<boolean> }) {
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
    if (await onRegister(parsed.fen)) { setValue(""); setOpen(false) }
  }
  return <Sheet open={open} onOpenChange={next => { if (busy) return; setOpen(next); if (!next) { setValue(""); setLocalError("") } }}>
    <SheetTrigger asChild><Button type="button" variant="outline" size="sm">{budget ? "调整预算" : "登记预算"}</Button></SheetTrigger>
    <SheetContent className="overflow-auto">
      <SheetHeader><SheetTitle>{budget ? "调整模型调用预算" : "登记模型调用预算"}</SheetTitle></SheetHeader>
      <form className="flex flex-col gap-4 px-4 pb-4" onSubmit={event => void submit(event)}>
        {display && <p className="text-sm">当前上限：{display.limit}；已预留与已用合计：{display.committed}；剩余：{display.remaining}。</p>}
        <FieldGroup><Field><FieldLabel htmlFor="verification-budget-limit">预算上限（元）</FieldLabel><Input id="verification-budget-limit" inputMode="decimal" required maxLength={24} placeholder="例如 300" value={value} disabled={busy} onChange={event => { setValue(event.target.value); setLocalError("") }} /></Field></FieldGroup>
        {(localError || error) && <p role="alert" className="text-sm text-destructive">{localError || error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "正在登记" : "确认登记"}</Button>
      </form>
    </SheetContent>
  </Sheet>
}
