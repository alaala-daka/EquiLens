"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { FileTextIcon, LoaderCircleIcon, PenLineIcon, ScaleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ExportRef, ResultValidation } from "@/lib/business/contracts"
import {
  createProjectDraftingClient,
  type DraftingInputSummaryView, type DraftingInputView, type DraftingTemplateFieldView, type DraftingTemplateView,
  type ProjectResultView, type ProjectReviewMaterial,
} from "@/lib/business/drafting-client"
import type { ProjectReviewError } from "@/lib/business/reviews-client"
import { downloadDocument } from "@/lib/documents/editor-access"
import { errorMessage } from "@/lib/documents/types"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import type { ProjectSummary } from "./projects-client"
import {
  DRAFTING_KIND_LABELS as KIND_LABELS,
  checkGenerateDraft, checkSaveInput, draftMissingCount, draftResultLabel, draftingEmptyState,
  emptyDraftingForm, fieldSourceLabel, fieldsBySection, formFromSavedInput, formSignature, isDraftingFormDirty,
  missingPreview, needsRegeneration, nextDraftingOperation, originalContractOptions, originalContractSelection,
  parseOriginalContractSelection, readDraftValue, reviewDecisionOptions, reviewLabel, sectionTitle, validationLabel,
  type DraftingForm, type DraftingOperation,
} from "./drafting-form"

type Busy = "" | "save" | "generate" | "validate" | "review" | "export" | "download" | "revise"

/**
 * C5 drafting workspace (spec 01 §4.4/§8.2.4, plan §5 C5).
 *
 * Two explicit steps: save the proposed-input version, then deterministically
 * generate a draft. The generated draft is always a `partial` server-owned
 * human result (fixed "待核对" template): it can be revalidated, rejected /
 * returned for changes and exported as a draft Word file, but never approved as
 * a complete review result. Read-only members see saved inputs/drafts and
 * download existing exports only. All requests are bound to this project
 * instance; late responses after unmount, project switch or access pause are
 * rejected by the client guard.
 */
export function ProjectDraftingWorkspace({ project, active, canEdit, blocked, isCurrent, onAccessInvalid, onOpenDocuments, registry }: {
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
    const life = { alive: true, blocked, editable: canEdit }
    const instance = createProjectDraftingClient({
      projectId: project.id,
      isCurrent: () => life.alive && isCurrent() && !life.blocked,
      canEdit: () => life.editable,
      onAccessInvalid: (failure: ProjectReviewError) => onAccessInvalid(failure),
    })
    return {
      client: instance,
      isCurrent: () => life.alive && isCurrent() && !life.blocked,
      start() { life.alive = true },
      stop() { life.alive = false },
      configure(next: { blocked: boolean; editable: boolean }) { life.blocked = next.blocked; life.editable = next.editable },
    }
  })
  const current = useCallback(() => runtime.isCurrent(), [runtime])
  const client = runtime.client
  const [templates, setTemplates] = useState<DraftingTemplateView[]>([])
  const [inputs, setInputs] = useState<DraftingInputSummaryView[]>([])
  const [drafts, setDrafts] = useState<ProjectResultView[]>([])
  const [materials, setMaterials] = useState<ProjectReviewMaterial[]>([])
  const [selectedInputId, setSelectedInputId] = useState("")
  const [savedInput, setSavedInput] = useState<DraftingInputView | null>(null)
  const [form, setForm] = useState<DraftingForm>(() => emptyDraftingForm("specialty-subcontract-v1"))
  const [selectedResultId, setSelectedResultId] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState<Busy>("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [formIssues, setFormIssues] = useState<string[]>([])
  const [reviewComment, setReviewComment] = useState("")
  const [reviewDecision, setReviewDecision] = useState<"rejected" | "changes_requested">("changes_requested")
  const [validationOverride, setValidationOverride] = useState<Record<string, ResultValidation>>({})
  const [exports, setExports] = useState<ExportRef[]>([])
  const [exportsError, setExportsError] = useState("")
  const [exportsVersion, setExportsVersion] = useState(0)
  const saveOperation = useRef<DraftingOperation | null>(null)
  const generateOperation = useRef<DraftingOperation | null>(null)
  const [actions] = useState(() => new Set<AbortController>())
  const beginAction = useCallback(() => {
    const controller = new AbortController()
    actions.add(controller)
    return controller
  }, [actions])
  const endAction = useCallback((controller: AbortController) => { actions.delete(controller) }, [actions])
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible")
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
    runtime.configure({ blocked, editable: canEdit })
  }, [runtime, blocked, canEdit])

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  const applyInput = useCallback((view: DraftingInputView) => {
    setSavedInput(view)
    setSelectedInputId(view.input.inputId)
    setForm(formFromSavedInput(view))
    setFormIssues([])
  }, [])

  const selectedInputIdRef = useRef(selectedInputId)
  useEffect(() => { selectedInputIdRef.current = selectedInputId }, [selectedInputId])

  useEffect(() => {
    if (!active || blocked || !visible) return
    const controller = new AbortController()
    void (async () => {
      if (!loadedOnce.current) setLoading(true)
      setLoadError("")
      try {
        const [catalog, draftRows, materialRows] = await Promise.all([
          client.listInputs(controller.signal),
          client.listDrafts(controller.signal),
          client.listMaterials(controller.signal),
        ])
        if (!current() || controller.signal.aborted) return
        loadedOnce.current = true
        setTemplates(catalog.templates)
        setInputs(catalog.inputs)
        setDrafts(draftRows)
        setMaterials(materialRows)
        const target = catalog.inputs.find(input => input.inputId === selectedInputIdRef.current) ?? catalog.inputs[0]
        if (target) {
          const detail = await client.getInput(target.inputId, controller.signal)
          if (!current() || controller.signal.aborted) return
          applyInput(detail)
        } else {
          setForm(previous => catalog.templates.some(template => template.id === previous.templateId)
            ? previous
            : emptyDraftingForm(catalog.templates[0]?.id ?? "specialty-subcontract-v1"))
        }
      } catch (failure) {
        if (current() && !controller.signal.aborted) setLoadError(errorMessage(failure))
      } finally {
        if (current() && !controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [active, blocked, visible, reloadToken, client, current, applyInput])

  const selectedResult = drafts.find(draft => draft.resultId === selectedResultId) ?? null
  const selectedValue = selectedResult ? readDraftValue(selectedResult.value) : null
  const template = templates.find(item => item.id === form.templateId) ?? null

  useEffect(() => {
    if (!selectedResult) return
    const controller = new AbortController()
    void (async () => {
      try {
        const rows = await client.listExports(selectedResult.resultId, controller.signal)
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
  }, [selectedResult, exportsVersion, client, current])

  const dirty = canEdit && isDraftingFormDirty(form)
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])

  const saveInput = useCallback(async (): Promise<boolean> => {
    if (!template || !canEdit || blocked) return false
    const check = checkSaveInput(template, form, canEdit)
    if (!check.ok) { setFormIssues(check.issues); return false }
    const signature = formSignature(form, "save")
    const operation = nextDraftingOperation(saveOperation.current, signature, () => crypto.randomUUID())
    saveOperation.current = operation
    const controller = beginAction()
    setBusy("save")
    setFormIssues([])
    setNotice("")
    try {
      const values: Record<string, string> = {}
      for (const field of template.fields) {
        const value = (form.values[field.id] ?? "").trim()
        if (value) values[field.id] = value
      }
      const view = await client.saveInput({
        templateId: template.id,
        ...(form.inputId ? { inputId: form.inputId } : {}),
        baseVersionId: form.inputId ? form.versionId : "",
        operationId: operation.key,
        fields: values,
        ...(form.originalContract ? { originalContract: form.originalContract } : {}),
      }, controller.signal)
      if (!current() || controller.signal.aborted) return false
      saveOperation.current = null
      applyInput(view)
      setInputs(rows => [view.input, ...rows.filter(row => row.inputId !== view.input.inputId)])
      setNotice(`拟约定输入已保存为第 ${view.input.version} 版。`)
      return true
    } catch (failure) {
      if (current() && !controller.signal.aborted) setFormIssues([errorMessage(failure)])
      return false
    } finally {
      endAction(controller)
      if (current()) setBusy("")
    }
  }, [template, canEdit, blocked, form, client, current, beginAction, endAction, applyInput])

  // Unsaved proposed input is registered so "save and leave" persists a version before navigation.
  useEffect(() => {
    if (!canEdit || blocked || !dirty || !template) return
    return registry.register({
      id: `drafting-input:${project.id}`,
      label: "拟约定输入",
      save: saveInput,
      discard() {
        if (savedInput) applyInput(savedInput)
        else if (templates[0]) setForm(emptyDraftingForm(templates[0].id))
      },
    })
  }, [canEdit, blocked, dirty, template, project.id, registry, saveInput, savedInput, templates, applyInput])

  async function generateDraft() {
    if (!template || busy !== "" || !canEdit || blocked) return
    const check = checkGenerateDraft(template, form, canEdit)
    if (!check.ok) { setFormIssues(check.issues); return }
    const signature = formSignature(form, "generate")
    const operation = nextDraftingOperation(generateOperation.current, signature, () => crypto.randomUUID())
    generateOperation.current = operation
    const controller = beginAction()
    setBusy("generate")
    setFormIssues([])
    setNotice("")
    try {
      const draft = await client.generateDraft({
        inputId: form.inputId, versionId: form.versionId, sha256: form.sha256,
        operationId: operation.key, reason: "生成文书草稿",
      }, controller.signal)
      if (!current() || controller.signal.aborted) return
      generateOperation.current = null
      setDrafts(rows => mergeDrafts(rows, draft))
      setSelectedResultId(draft.resultId)
      setActionError("")
      setNotice("草稿已生成。待核对模板只能形成部分完成草稿，不能批准为完整复核成果。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setFormIssues([errorMessage(failure)])
    } finally {
      endAction(controller)
      if (current()) setBusy("")
    }
  }

  async function reviseDraft() {
    if (!selectedResult || !template || !form.versionId || busy !== "" || !canEdit || blocked) return
    const signature = formSignature(form, "revise", selectedResult.resultId)
    const operation = nextDraftingOperation(generateOperation.current, signature, () => crypto.randomUUID())
    generateOperation.current = operation
    const controller = beginAction()
    setBusy("revise")
    setActionError("")
    setNotice("")
    try {
      const draft = await client.reviseDraft(selectedResult.resultId, {
        baseVersionId: selectedResult.versionId,
        inputId: form.inputId, versionId: form.versionId, sha256: form.sha256,
        operationId: operation.key, reason: "按当前拟约定输入重渲染",
      }, controller.signal)
      if (!current() || controller.signal.aborted) return
      generateOperation.current = null
      setDrafts(rows => mergeDrafts(rows, draft))
      setSelectedResultId(draft.resultId)
      setNotice("已生成新的草稿版本，原版本保留；整份复核状态已重置。")
    } catch (failure) {
      if (current() && !controller.signal.aborted) setActionError(errorMessage(failure))
    } finally {
      endAction(controller)
      if (current()) setBusy("")
    }
  }

  function validateDraft(draft: ProjectResultView) {
    void (async () => {
      if (busy !== "" || !current()) return
      const controller = beginAction()
      setBusy("validate")
      setActionError("")
      try {
        const checked = await client.validateDraft({ resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256 }, controller.signal)
        if (!current()) return
        setValidationOverride(rows => ({ ...rows, [`${draft.resultId}:${draft.versionId}`]: checked }))
      } catch (failure) {
        if (current() && !controller.signal.aborted) setActionError(errorMessage(failure))
      } finally {
        endAction(controller)
        if (current()) setBusy("")
      }
    })()
  }

  function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedResult || busy !== "" || !canEdit || blocked) return
    void (async () => {
      const controller = beginAction()
      setBusy("review")
      setActionError("")
      try {
        const updated = await client.reviewDraft({
          resultId: selectedResult.resultId, versionId: selectedResult.versionId, sha256: selectedResult.sha256,
          decision: reviewDecision, comment: reviewComment,
        }, controller.signal)
        if (!current() || controller.signal.aborted) return
        setDrafts(rows => rows.map(row => row.resultId === updated.resultId ? updated : row))
        setReviewComment("")
        setNotice("复核记录已保存。")
      } catch (failure) {
        if (current() && !controller.signal.aborted) setActionError(errorMessage(failure))
      } finally {
        endAction(controller)
        if (current()) setBusy("")
      }
    })()
  }

  function createExport(draft: ProjectResultView) {
    void (async () => {
      if (busy !== "" || !canEdit || blocked) return
      const controller = beginAction()
      setBusy("export")
      setExportsError("")
      try {
        const created = await client.createExport({ resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256 }, controller.signal)
        if (!current() || controller.signal.aborted) return
        setExportsVersion(value => value + 1)
        setExports(rows => [created, ...rows.filter(row => row.exportId !== created.exportId)])
        const blob = await client.downloadExport(draft.resultId, created.exportId, controller.signal)
        if (!current()) return
        downloadDocument(blob, exportFileName(draft))
      } catch (failure) {
        if (current() && !controller.signal.aborted) setExportsError(errorMessage(failure))
      } finally {
        endAction(controller)
        if (current()) setBusy("")
      }
    })()
  }

  function downloadExport(draft: ProjectResultView, exportRef: ExportRef) {
    void (async () => {
      if (busy !== "") return
      const controller = beginAction()
      setBusy("download")
      setExportsError("")
      try {
        const blob = await client.downloadExport(draft.resultId, exportRef.exportId, controller.signal)
        if (!current()) return
        downloadDocument(blob, exportFileName(draft))
      } catch (failure) {
        if (current() && !controller.signal.aborted) setExportsError(errorMessage(failure))
      } finally {
        endAction(controller)
        if (current()) setBusy("")
      }
    })()
  }

  function updateField(fieldId: string, value: string) {
    setForm(form => ({ ...form, values: { ...form.values, [fieldId]: value } }))
    setFormIssues([])
    setNotice("")
  }

  function selectInput(inputId: string) {
    if (dirty) { setNotice("拟约定输入有未保存修改，请先保存或放弃后再切换。"); return }
    if (!inputId) return
    void (async () => {
      const controller = beginAction()
      setActionError("")
      try {
        const detail = await client.getInput(inputId, controller.signal)
        if (!current() || controller.signal.aborted) return
        applyInput(detail)
        setNotice("")
      } catch (failure) {
        if (current() && !controller.signal.aborted) setActionError(errorMessage(failure))
      } finally { endAction(controller) }
    })()
  }

  function discardForm() {
    if (savedInput) applyInput(savedInput)
    else if (templates[0]) setForm(emptyDraftingForm(templates[0].id))
    setFormIssues([])
    setNotice("已放弃未保存的拟约定输入。")
  }

  const selectedValidation = selectedResult
    ? validationOverride[`${selectedResult.resultId}:${selectedResult.versionId}`] ?? selectedResult.validation
    : null
  const missing = selectedValue?.missing ?? (template ? missingPreview(template, form.values) : [])
  const saveCheck = template ? checkSaveInput(template, form, canEdit) : { ok: false, issues: [] }
  const generateCheck = checkGenerateDraft(template, form, canEdit)
  const canRevise = Boolean(selectedResult && selectedValue && form.versionId && canEdit && !blocked && busy === "" &&
    needsRegeneration(selectedResult, form))
  const originalOptions = form.templateId === "supplementary-agreement-v1"
    ? originalContractOptions(materials.map(material => ({ id: material.id, title: material.title, versionId: material.versionId })), drafts)
    : []

  return <div className="flex flex-col gap-6">
    {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">状态获取失败：{loadError}</p><Button type="button" variant="outline" onClick={() => setReloadToken(value => value + 1)}>重试</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

    <form aria-label="拟约定输入" className="flex flex-col gap-4 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void saveInput() }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">拟约定输入</h2>
        <div className="flex flex-wrap items-center gap-2">
          {inputs.length > 0 && <label className="flex items-center gap-2 text-sm">已保存输入
            <NativeSelect aria-label="选择已保存的拟约定输入" value={selectedInputId} disabled={busy !== "" || dirty}
              onChange={event => selectInput(event.target.value)}>
              {inputs.map(input => <NativeSelectOption key={input.inputId} value={input.inputId}>{input.templateLabel} · 第 {input.version} 版{input.missingCount ? `（缺失 ${input.missingCount}）` : ""}</NativeSelectOption>)}
            </NativeSelect>
          </label>}
          {canEdit && <Button type="button" variant="outline" size="sm" disabled={busy !== "" || dirty}
            onClick={() => { setSavedInput(null); setSelectedInputId(""); setForm(emptyDraftingForm(form.templateId)); setNotice("") }}>新建输入</Button>}
          <Button type="button" variant="outline" size="sm" disabled={busy !== ""} onClick={() => setReloadToken(value => value + 1)}>刷新</Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm">文书模板
          <NativeSelect aria-label="文书模板" value={form.templateId} disabled={busy !== "" || dirty || Boolean(form.inputId)}
            onChange={event => { setSavedInput(null); setSelectedInputId(""); setForm(emptyDraftingForm(event.target.value)); setFormIssues([]) }}>
            {templates.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.label}（{item.version} · {item.status}）</NativeSelectOption>)}
          </NativeSelect>
          {dirty && <span className="text-xs text-muted-foreground">有未保存修改；保存或放弃后才能切换模板。</span>}
        </label>
        <div className="grid gap-1 text-sm">
          <span className="font-medium">模板状态</span>
          <span className="flex items-center gap-2"><Badge variant="outline">待核对</Badge><span className="text-xs text-muted-foreground">未完成领域核对，只能形成部分完成草稿。</span></span>
        </div>
      </div>
      {template?.originalContract && <label className="grid gap-2 text-sm">本项目原合同版本
        <NativeSelect aria-label="本项目原合同版本" value={originalContractSelection(form.originalContract)} disabled={busy !== ""}
          onChange={event => {
            const ref = parseOriginalContractSelection(event.target.value, originalOptions)
            setForm(form => ({ ...form, originalContract: ref }))
            setFormIssues([])
          }}>
          <NativeSelectOption value="">请选择原合同版本</NativeSelectOption>
          {originalOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
        </NativeSelect>
        {originalOptions.length === 0 && <span className="text-xs text-muted-foreground">暂无可作为原合同的项目材料；请先在文档中上传并解析材料。</span>}
      </label>}
      <div className="flex flex-col gap-4">
        {template ? fieldsBySection(template).map(group => <fieldset key={group.section.id} className="space-y-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{group.section.title}</legend>
          <FieldGroup className="grid gap-4 md:grid-cols-2">
            {group.fields.map(field => <DraftingFieldInput key={field.id} field={field} template={template} value={form.values[field.id] ?? ""}
              disabled={!canEdit || busy !== ""} onChange={value => updateField(field.id, value)} />)}
          </FieldGroup>
        </fieldset>) : <p role="status" className="text-sm">正在读取文书模板</p>}
      </div>
      {missing.length > 0 && <div className="rounded-md border p-3 text-sm">
        <p className="font-medium">待补充字段（{missing.length} 项）</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {missing.map(field => <li key={field.fieldId}>{field.label} · {template ? sectionTitle(template, field.section) : field.section} · {field.reason === "conditional" ? "条件必填" : "必填"}</li>)}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">缺失字段在草稿中保留【待补充：标签】标记，系统不会补造任何内容。</p>
      </div>}
      {formIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{formIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && <Button type="submit" disabled={busy !== "" || !saveCheck.ok}>{busy === "save" ? "正在保存" : form.inputId ? "保存新版本" : "保存拟约定输入"}</Button>}
        {canEdit && dirty && <Button type="button" variant="outline" disabled={busy !== ""} onClick={discardForm}>放弃修改</Button>}
        {canEdit && <Button type="button" variant="secondary" disabled={busy !== "" || !generateCheck.ok} onClick={() => void generateDraft()}>{busy === "generate" ? "正在生成" : "生成草稿"}</Button>}
        {form.inputId && <span className="text-xs text-muted-foreground">已保存：第 {form.version} 版 · 摘要 {form.sha256.slice(0, 12)}…</span>}
        {!canEdit && <span role="note" className="text-xs text-muted-foreground">只读成员可查看已有草稿并下载已有导出文件，不能保存、复核或生成导出。</span>}
      </div>
    </form>

    <section aria-label="文书草稿" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">文书草稿</h2>
        <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => setReloadToken(value => value + 1)}>刷新</Button>
      </div>
      {loading && drafts.length === 0 && <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在读取文书草稿</p>}
      {!loading && drafts.length === 0 && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><PenLineIcon /></EmptyMedia><EmptyTitle>{draftingEmptyState("drafts")}</EmptyTitle></EmptyHeader></Empty>}
      {drafts.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>文书</TableHead><TableHead>生成时间</TableHead><TableHead>缺失字段</TableHead><TableHead>校验</TableHead><TableHead>复核</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {drafts.map(draft => {
          const rowValidation = validationOverride[`${draft.resultId}:${draft.versionId}`] ?? draft.validation
          return <TableRow key={draft.resultId}>
            <TableCell className="whitespace-normal">{draftResultLabel(draft)}</TableCell>
            <TableCell className="whitespace-normal">{formatTime(draft.createdAt)}</TableCell>
            <TableCell>{draftMissingCount(draft)}</TableCell>
            <TableCell>{validationLabel(rowValidation.status)}</TableCell>
            <TableCell>{reviewLabel(draft.review?.decision ?? null)}</TableCell>
            <TableCell><Button type="button" variant={selectedResultId === draft.resultId ? "secondary" : "link"} onClick={() => { setActionError(""); setSelectedResultId(draft.resultId) }}>查看</Button></TableCell>
          </TableRow>
        })}
      </TableBody></Table></div>}
      {!loading && drafts.length === 0 && inputs.length === 0 && <p className="text-sm text-muted-foreground">{draftingEmptyState("inputs")}</p>}
      {selectedResult && selectedValue && selectedValidation && <section aria-label="草稿详情" className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{KIND_LABELS[selectedValue.kind]}</Badge>
          <Badge variant="outline">模板 {selectedValue.template.id} {selectedValue.template.version}</Badge>
          <Badge variant="outline">待核对</Badge>
          <Badge variant={selectedValidation.status === "invalid" ? "destructive" : "secondary"}>{validationLabel(selectedValidation.status)}</Badge>
          <span className="text-xs text-muted-foreground">复核：{reviewLabel(selectedResult.review?.decision ?? null)}</span>
        </div>
        <p role="note" className="text-sm text-muted-foreground">待核对模板生成的草稿为部分完成（partial），不能批准为完整复核成果；缺失字段保留【待补充】标记。</p>
        <p className="break-all text-xs text-muted-foreground">拟约定输入：第 {selectedValue.input.version} 版 · {selectedValue.input.versionId} · 摘要 {selectedValue.input.sha256}</p>
        {selectedValue.originalContract && <p className="text-sm">原合同：{selectedValue.originalContract.title} · {selectedValue.originalContract.kind === "material" ? "材料版本" : "成果版本"} {selectedValue.originalContract.versionId}</p>}
        {selectedValue.missing.length > 0 && <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">缺失字段（{selectedValue.missing.length} 项）</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{selectedValue.missing.map(field => <li key={field.fieldId}>【待补充：{field.label}】· {field.section} · {field.reason === "conditional" ? "条件必填" : "必填"}</li>)}</ul>
        </div>}
        <div className="space-y-2 rounded-lg border p-4 text-sm">
          {selectedValue.paragraphs.map((paragraph, index) => <p key={index} className="whitespace-pre-wrap">{paragraph}</p>)}
        </div>
        {selectedValidation.issues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{selectedValidation.issues.map((issue, index) => <p key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</p>)}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== ""} onClick={() => validateDraft(selectedResult)}>{busy === "validate" ? "正在重验" : "重验"}</Button>
          {canEdit && <Sheet>
            <SheetTrigger asChild><Button type="button" variant="outline" size="sm" disabled={busy !== ""}>复核</Button></SheetTrigger>
            <SheetContent className="overflow-auto">
              <SheetHeader><SheetTitle>复核文书草稿</SheetTitle></SheetHeader>
              <form className="flex flex-col gap-4 px-4 pb-4" onSubmit={submitReview}>
                <p className="text-sm text-muted-foreground">待核对模板的草稿不能批准为完整复核成果，只能驳回或退回修改。</p>
                <label className="grid gap-2 text-sm">结论
                  <NativeSelect aria-label="复核结论" value={reviewDecision} onChange={event => setReviewDecision(event.target.value as "rejected" | "changes_requested")}>
                    {reviewDecisionOptions(selectedValidation.status).map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
                  </NativeSelect>
                </label>
                <FieldGroup><Field><FieldLabel htmlFor="drafting-review-comment">复核意见</FieldLabel><Input id="drafting-review-comment" required maxLength={500} value={reviewComment} onChange={event => setReviewComment(event.target.value)} /></Field></FieldGroup>
                <Button type="submit" disabled={busy !== "" || !reviewComment.trim()}>{busy === "review" ? "正在保存" : "保存复核记录"}</Button>
              </form>
            </SheetContent>
          </Sheet>}
          {canEdit && <Button type="button" size="sm" disabled={busy !== "" || selectedValidation.status === "invalid"} onClick={() => createExport(selectedResult)}>{busy === "export" ? "正在生成" : "创建并下载 Word"}</Button>}
          {canEdit && canRevise && <Button type="button" variant="secondary" size="sm" disabled={busy !== ""} onClick={() => void reviseDraft()}>{busy === "revise" ? "正在重渲染" : "按当前拟约定输入重渲染"}</Button>}
          {canEdit && !canRevise && form.versionId && <span className="text-xs text-muted-foreground">当前草稿已固定该拟约定输入版本；补齐后可保存新版本再重渲染。</span>}
        </div>
        {exportsError && <p role="alert" className="text-sm text-destructive">{exportsError}</p>}
        {exports.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>导出文件</TableHead><TableHead>生成时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {exports.map(exportRef => <TableRow key={exportRef.exportId}>
            <TableCell className="break-all text-xs">{exportRef.exportId}</TableCell>
            <TableCell>{formatTime(exportRef.createdAt)}</TableCell>
            <TableCell><Button type="button" variant="link" disabled={busy !== ""} onClick={() => downloadExport(selectedResult, exportRef)}>{busy === "download" ? "正在下载" : "下载 Word"}</Button></TableCell>
          </TableRow>)}
        </TableBody></Table></div>}
      </section>}
      {!selectedResult && drafts.length > 0 && <p role="note" className="text-sm text-muted-foreground">选择一条草稿查看正文、缺失字段、校验与复核状态及导出文件。</p>}
      {materials.length === 0 && form.templateId === "supplementary-agreement-v1" && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>{draftingEmptyState("materials")}</EmptyTitle></EmptyHeader><Button type="button" variant="outline" onClick={onOpenDocuments}>前往文档上传资料</Button></Empty>}
      {templates.length === 0 && !loading && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><ScaleIcon /></EmptyMedia><EmptyTitle>暂无可用文书模板</EmptyTitle></EmptyHeader></Empty>}
    </section>
  </div>
}

function DraftingFieldInput({ field, template, value, disabled, onChange }: {
  field: DraftingTemplateFieldView
  template: DraftingTemplateView
  value: string
  disabled: boolean
  onChange(value: string): void
}) {
  const conditional = field.required !== "always"
  const label = `${field.label}${conditional ? "（条件必填）" : field.required === "always" ? "（必填）" : ""}`
  const common = { id: `drafting-field-${field.id}`, value, disabled, maxLength: field.maxLength, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }
  return <Field>
    <FieldLabel htmlFor={`drafting-field-${field.id}`}>{label}</FieldLabel>
    {field.kind === "choice"
      ? <NativeSelect id={`drafting-field-${field.id}`} aria-label={field.label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        <NativeSelectOption value="">请选择</NativeSelectOption>
        {(field.choices ?? []).map(choice => <NativeSelectOption key={choice.value} value={choice.value}>{choice.label}</NativeSelectOption>)}
      </NativeSelect>
      : field.kind === "date"
        ? <Input {...common} type="date" />
        : field.kind === "amount"
          ? <Input {...common} inputMode="decimal" placeholder="例如 1000000.00" />
          : field.maxLength > 200
            ? <Textarea {...common} rows={3} />
            : <Input {...common} />}
    <p className="text-xs text-muted-foreground">来源：{fieldSourceLabel()} · 章节：{sectionTitle(template, field.section)}</p>
  </Field>
}

function mergeDrafts(rows: ProjectResultView[], draft: ProjectResultView): ProjectResultView[] {
  return [draft, ...rows.filter(row => row.resultId !== draft.resultId)]
}

function exportFileName(draft: ProjectResultView): string {
  const value = readDraftValue(draft.value)
  const label = value ? KIND_LABELS[value.kind] : "文书草稿"
  return `${label}-草稿.docx`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
