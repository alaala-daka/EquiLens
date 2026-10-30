"use client"

import { useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { MaterialSnapshotRead, SnapshotFragment } from "@/lib/business/materials-client"
import {
  DATE_OPERATORS, LIST_OPERATORS,
  type RequirementCondition, type RequirementGroup, type RequirementSetValue, type VerificationRequirement,
} from "@/lib/business/verification-types"
import type { VerificationMaterial } from "@/lib/business/verifications-client"
import { VerificationFragmentPicker } from "./verification-fragment-picker"
import {
  addendumOptions, asOfRuleOptions, checkRequirementItem, checkRequirementSet, fieldKeyOptions,
  natureOptions, newManualRequirement, operatorOptions, preparedRequirementSet,
  rejectRequirement, requirementExpressionLabel, requirementSetCounts, requirementSourceLabel,
  requirementSourceMaterial, requirementSetStatusLabel, updateRejectedReason, updateRequirement,
  removeRejected, quoteMatchesFragment,
} from "./verification-state"

type PickerState = {
  mode: "add" | "source"
  requirementId?: string
  material: VerificationMaterial
  fragments: SnapshotFragment[]
}

/**
 * Requirement-set editor for machine candidates and manual entry.
 *
 * The editor only shapes the value; the server-owned save re-reads every
 * material version, snapshot and fragment and rejects a forged or mismatched
 * quote. A requirement can be saved as candidate (pending items) but only a
 * fully confirmed, expressible set can be used for a comparison task.
 */
export function VerificationRequirementEditor({ value, materials, source, canEdit, busy, error, isCurrent, onChange, onSave, onClose, loadSnapshot }: {
  value: RequirementSetValue
  materials: readonly VerificationMaterial[]
  source: "machine" | "manual"
  canEdit: boolean
  busy: boolean
  error: string
  isCurrent: () => boolean
  onChange(value: RequirementSetValue): void
  onSave(value: RequirementSetValue): void
  onClose(): void
  loadSnapshot(material: VerificationMaterial): Promise<MaterialSnapshotRead | null>
}) {
  const [addMaterialId, setAddMaterialId] = useState("")
  const [rejecting, setRejecting] = useState<{ requirementId: string; reason: string } | null>(null)
  const [saveIssues, setSaveIssues] = useState<string[]>([])
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState("")
  const counts = requirementSetCounts(value)
  const sourceMaterials = materials.filter(requirementSourceMaterial)
  const update = (next: RequirementSetValue) => { setSaveIssues([]); onChange(next) }

  async function openPicker(mode: "add" | "source", material: VerificationMaterial, requirementId?: string) {
    if (!material.snapshotId) return
    setPicker({ mode, requirementId, material, fragments: [] })
    setPickerLoading(true)
    setPickerError("")
    const read = await loadSnapshot(material)
    if (!isCurrent()) return
    setPickerLoading(false)
    if (!read) { setPickerError("材料解析快照读取失败，请重试。"); return }
    setPicker(current => current && current.material.id === material.id ? { ...current, fragments: read.fragments } : current)
  }

  function addRequirement(fragment: SnapshotFragment, material: VerificationMaterial) {
    update({ ...value, requirements: [...value.requirements, newManualRequirement(fragment, material, value)] })
    setAddMaterialId("")
  }

  function changeSource(requirement: VerificationRequirement, fragment: SnapshotFragment, snapshotId: string) {
    update(updateRequirement(value, requirement.requirementId, {
      source: { snapshotId, fragmentId: fragment.id },
      quote: quoteMatchesFragment(fragment.text, requirement.quote) ? requirement.quote : fragment.text,
    }))
  }

  function setExpressionMode(requirement: VerificationRequirement, mode: "none" | "field" | "group") {
    if (mode === "none") {
      update(updateRequirement(value, requirement.requirementId, { field: null, operator: null, value: null, group: null, status: "pending", statusNote: "比较条件待补充。" }))
      return
    }
    if (mode === "group") {
      update(updateRequirement(value, requirement.requirementId, {
        field: null, operator: null, value: null,
        group: { operator: "and", conditions: [{ field: "subject_name", operator: "eq", value: "" }] },
      }))
      return
    }
    update(updateRequirement(value, requirement.requirementId, {
      field: requirement.field ?? "subject_name",
      operator: requirement.operator ?? "eq",
      value: requirement.value ?? "",
      group: null,
    }))
  }

  function confirm(requirement: VerificationRequirement) {
    const checked = checkRequirementItem({ ...requirement, status: "confirmed", statusNote: "" }, value.requirements.findIndex(item => item.requirementId === requirement.requirementId))
    if (checked.issues.length) return
    update(updateRequirement(value, requirement.requirementId, { status: "confirmed", statusNote: "" }))
  }

  function save() {
    const prepared = preparedRequirementSet(value)
    const checked = checkRequirementSet(prepared)
    const issues = checked.issues
    if (issues.length) { setSaveIssues(issues); return }
    setSaveIssues([])
    onSave(prepared)
  }

  function conditionValueText(value: string | string[] | null): string {
    return Array.isArray(value) ? value.join("、") : value ?? ""
  }

  function setCondition(requirement: VerificationRequirement, condition: RequirementCondition) {
    update(updateRequirement(value, requirement.requirementId, { field: condition.field, operator: condition.operator, value: condition.value }))
  }

  function setValueText(requirement: VerificationRequirement, text: string) {
    if (requirement.operator && LIST_OPERATORS.includes(requirement.operator)) {
      const items = text.split(/[，,、]/).map(item => item.trim()).filter(Boolean)
      update(updateRequirement(value, requirement.requirementId, { value: items }))
      return
    }
    update(updateRequirement(value, requirement.requirementId, { value: text }))
  }

  function setGroup(requirement: VerificationRequirement, group: RequirementGroup) {
    update(updateRequirement(value, requirement.requirementId, { group }))
  }

  function changeGroupCondition(requirement: VerificationRequirement, group: RequirementGroup, index: number, condition: RequirementCondition) {
    setGroup(requirement, { ...group, conditions: group.conditions.map((item, position) => position === index ? condition : item) })
  }

  return <section aria-label="要求集编辑" className="flex flex-col gap-4 rounded-lg border p-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">要求集编辑</h3>
        <p className="text-sm text-muted-foreground">{source === "machine" ? "机器候选要求（待人工确认）" : "人工录入要求集"} · {requirementSetStatusLabel(value)}</p>
        <p className="text-sm">共 {counts.total} 条 · 已确认 {counts.confirmed} 条 · 待确认 {counts.pending} 条 · 性质待确认 {counts.pendingNature} 条 · 驳回 {counts.rejected} 条</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>返回成果列表</Button>
        {canEdit && <Button type="button" size="sm" disabled={busy} onClick={save}>{busy ? "正在保存" : "保存要求集"}</Button>}
      </div>
    </header>
    {!canEdit && <p role="note" className="text-sm text-muted-foreground">只读成员可查看要求集，不能确认、更正或保存。</p>}
    {value.warnings.length > 0 && <div role="status" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">{value.warnings.map((warning, index) => <p key={index} className="break-words">{warning}</p>)}</div>}
    {value.errors.length > 0 && <div role="alert" className="space-y-1 rounded-md border p-3 text-sm text-destructive">{value.errors.map((entry, index) => <p key={index} className="break-words">{entry.code}：{entry.message}</p>)}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {pickerError && <p role="alert" className="text-sm text-destructive">{pickerError}</p>}
    {saveIssues.length > 0 && <div role="alert" className="space-y-1 rounded-md border p-3 text-sm text-destructive">
      <p className="font-medium">要求集未通过保存前检查（{saveIssues.length} 项）</p>
      {saveIssues.map((issue, index) => <p key={index} className="break-words">{issue}</p>)}
    </div>}

    {value.requirements.length === 0 && <p role="status" className="text-sm text-muted-foreground">暂无要求条目</p>}
    {value.requirements.map(requirement => {
      const issues = checkRequirementItem(requirement, value.requirements.indexOf(requirement)).issues
      const mode: "none" | "field" | "group" = requirement.group ? "group" : requirement.field && requirement.operator ? "field" : "none"
      const operator = requirement.operator
      const dateOperator = operator !== null && DATE_OPERATORS.includes(operator)
      const listOperator = operator !== null && LIST_OPERATORS.includes(operator)
      return <Collapsible key={requirement.requirementId} defaultOpen={requirement.status !== "confirmed"}>
        <CollapsibleTrigger asChild><Button type="button" variant="outline" className="h-auto w-full justify-start whitespace-normal text-left">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{requirement.requirementId}</span><Badge variant={requirement.status === "confirmed" ? "default" : "secondary"}>{requirement.status === "confirmed" ? "已确认" : "待确认"}</Badge><Badge variant="outline">{requirement.nature}</Badge>{requirement.addendum.state === "conflict" && <Badge variant="destructive">补遗冲突</Badge>}</span>
            <span className="text-xs text-muted-foreground">{requirement.subject || "未填写义务主体"} · {requirementExpressionLabel(requirement)}</span>
          </span>
        </Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {issues.length > 0 && <ul className="list-disc space-y-1 rounded-md border p-3 pl-7 text-sm text-destructive">{issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm">义务主体<Input value={requirement.subject} maxLength={200} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { subject: event.target.value }))} placeholder="填写原文中的义务主体" /></label>
            <label className="grid gap-2 text-sm">材料关系<Input value={requirement.materialRelation} maxLength={200} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { materialRelation: event.target.value }))} placeholder="如：企业资质证书 / 人员证书" /></label>
            <label className="grid gap-2 text-sm">要求性质<NativeSelect value={requirement.nature} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { nature: event.target.value as VerificationRequirement["nature"] }))}>{natureOptions.map(item => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></label>
            <label className="grid gap-2 text-sm">补遗状态<NativeSelect value={requirement.addendum.state} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { addendum: { ...requirement.addendum, state: event.target.value as VerificationRequirement["addendum"]["state"] } }))}>{addendumOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>
            {requirement.addendum.state !== "none" && <label className="grid gap-2 text-sm md:col-span-2">补遗说明<Input value={requirement.addendum.note} maxLength={500} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { addendum: { ...requirement.addendum, note: event.target.value } }))} /></label>}
            <label className="grid gap-2 text-sm md:col-span-2">原文引文<Textarea value={requirement.quote} maxLength={2000} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { quote: event.target.value }))} />
              <span className="text-xs text-muted-foreground">来源：{requirementSourceLabel(requirement, materials)}</span>
              {canEdit && <Button type="button" variant="link" size="sm" className="w-fit px-0" disabled={busy} onClick={() => {
                const material = materials.find(item => item.versionId === requirement.materialVersionId)
                if (material) void openPicker("source", material, requirement.requirementId)
              }}>更换来源片段</Button>}
            </label>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">比较条件</p>
            <NativeSelect aria-label="比较条件类型" value={mode} disabled={!canEdit || busy} onChange={event => setExpressionMode(requirement, event.target.value as "none" | "field" | "group")}>
              <NativeSelectOption value="none">待补充（不能确认）</NativeSelectOption>
              <NativeSelectOption value="field">字段比较</NativeSelectOption>
              <NativeSelectOption value="group">条件分组（单层）</NativeSelectOption>
            </NativeSelect>
            {mode === "field" && <>
              <div className="grid gap-4 md:grid-cols-3">
                <label className="grid gap-2 text-sm">字段<NativeSelect value={requirement.field ?? "subject_name"} disabled={!canEdit || busy} onChange={event => setCondition(requirement, { ...conditionOf(requirement), field: event.target.value as RequirementCondition["field"] })}>{fieldKeyOptions().map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>
                <label className="grid gap-2 text-sm">比较运算<NativeSelect value={requirement.operator ?? "eq"} disabled={!canEdit || busy} onChange={event => setCondition(requirement, { ...conditionOf(requirement), operator: event.target.value as RequirementCondition["operator"] })}>{operatorOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>
                <label className="grid gap-2 text-sm">比较值<Input value={conditionValueText(requirement.value)} maxLength={500} disabled={!canEdit || busy} placeholder={listOperator ? "多项以顿号分隔" : dateOperator ? "留空表示使用任务判定日期" : "填写比较值"} onChange={event => setValueText(requirement, event.target.value)} /></label>
              </div>
              {dateOperator && <label className="grid gap-2 text-sm">判定时点<NativeSelect value={requirement.asOfRule} disabled={!canEdit || busy} onChange={event => update(updateRequirement(value, requirement.requirementId, { asOfRule: event.target.value as VerificationRequirement["asOfRule"] }))}>{asOfRuleOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>}
            </>}
            {mode === "group" && requirement.group && <>
              <label className="grid gap-2 text-sm">分组逻辑<NativeSelect value={requirement.group.operator} disabled={!canEdit || busy} onChange={event => setGroup(requirement, { ...requirement.group!, operator: event.target.value as RequirementGroup["operator"] })}><NativeSelectOption value="and">全部满足（且）</NativeSelectOption><NativeSelectOption value="or">任一满足（或）</NativeSelectOption></NativeSelect></label>
              <div className="space-y-2">
                {requirement.group.conditions.map((condition, index) => <div key={index} className="grid gap-2 md:grid-cols-4">
                  <NativeSelect aria-label={`条件 ${index + 1} 字段`} value={condition.field} disabled={!canEdit || busy} onChange={event => changeGroupCondition(requirement, requirement.group!, index, { ...condition, field: event.target.value as RequirementCondition["field"] })}>{fieldKeyOptions().map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect>
                  <NativeSelect aria-label={`条件 ${index + 1} 运算符`} value={condition.operator} disabled={!canEdit || busy} onChange={event => changeGroupCondition(requirement, requirement.group!, index, { ...condition, operator: event.target.value as RequirementCondition["operator"] })}>{operatorOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect>
                  <Input aria-label={`条件 ${index + 1} 比较值`} value={conditionValueText(condition.value)} maxLength={500} disabled={!canEdit || busy} onChange={event => {
                    const text = event.target.value
                    const value = LIST_OPERATORS.includes(condition.operator) ? text.split(/[，,、]/).map(item => item.trim()).filter(Boolean) : text
                    changeGroupCondition(requirement, requirement.group!, index, { ...condition, value })
                  }} />
                  {canEdit && <Button type="button" variant="ghost" size="sm" disabled={busy || requirement.group!.conditions.length <= 1} onClick={() => setGroup(requirement, { ...requirement.group!, conditions: requirement.group!.conditions.filter((_, position) => position !== index) })}><Trash2Icon />删除</Button>}
                </div>)}
              </div>
              {canEdit && <Button type="button" variant="outline" size="sm" disabled={busy || requirement.group.conditions.length >= 10} onClick={() => setGroup(requirement, { ...requirement.group!, conditions: [...requirement.group!.conditions, { field: "subject_name", operator: "eq", value: "" }] })}><PlusIcon />添加条件</Button>}
            </>}
          </div>
          {canEdit && <div className="flex flex-wrap items-center gap-2">
            {requirement.status === "confirmed"
              ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => update(updateRequirement(value, requirement.requirementId, { status: "pending", statusNote: "人工退回待确认。" }))}>退回待确认</Button>
              : <Button type="button" size="sm" disabled={busy || issues.length > 0} onClick={() => confirm(requirement)}>确认要求</Button>}
            {rejecting?.requirementId === requirement.requirementId
              ? <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="驳回理由" value={rejecting.reason} maxLength={500} placeholder="填写驳回理由" onChange={event => setRejecting({ requirementId: requirement.requirementId, reason: event.target.value })} />
                <Button type="button" variant="outline" size="sm" disabled={busy || !rejecting.reason.trim()} onClick={() => { update(rejectRequirement(value, requirement.requirementId, rejecting.reason)); setRejecting(null) }}>确认驳回</Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(null)}>取消</Button>
              </div>
              : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRejecting({ requirementId: requirement.requirementId, reason: "" })}>驳回候选</Button>}
          </div>}
        </CollapsibleContent>
      </Collapsible>
    })}

    {canEdit && <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">手工录入要求</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-56 flex-1 gap-2 text-sm">来源材料<NativeSelect value={addMaterialId} disabled={busy} onChange={event => setAddMaterialId(event.target.value)}><NativeSelectOption value="">请选择</NativeSelectOption>{sourceMaterials.map(material => <NativeSelectOption key={material.id} value={material.id}>{material.title}（{material.format.toUpperCase()}）</NativeSelectOption>)}</NativeSelect></label>
        <Button type="button" variant="outline" size="sm" disabled={busy || !addMaterialId} onClick={() => {
          const material = sourceMaterials.find(item => item.id === addMaterialId)
          if (material) void openPicker("add", material)
        }}>选择原文片段</Button>
      </div>
      <p className="text-xs text-muted-foreground">要求引文必须逐字来自所选材料解析快照的原文片段；保存时服务端会重新读取并核对。</p>
      {pickerError && <p role="alert" className="text-sm text-destructive">{pickerError}</p>}
    </div>}

    <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">驳回记录（{value.rejected.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">
        {value.rejected.length === 0 ? <p className="text-sm text-muted-foreground">暂无驳回记录</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>原引文</TableHead><TableHead>驳回理由</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {value.rejected.map((entry, index) => <TableRow key={index}>
            <TableCell className="max-w-md whitespace-normal break-words text-xs">{entry.quote || "未记录引文"}</TableCell>
            <TableCell><Input aria-label={`驳回理由 ${index + 1}`} value={entry.reason} maxLength={500} disabled={!canEdit || busy} onChange={event => update(updateRejectedReason(value, index, event.target.value))} /></TableCell>
            <TableCell>{canEdit && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => update(removeRejected(value, index))}>移除</Button>}</TableCell>
          </TableRow>)}
        </TableBody></Table></div>}
      </CollapsibleContent>
    </Collapsible>

    <VerificationFragmentPicker
      open={picker !== null}
      onOpenChange={open => { if (!open) setPicker(null) }}
      title={picker?.mode === "source" ? "更换要求来源片段" : "选择要求来源片段"}
      fragments={picker?.fragments ?? []}
      loading={pickerLoading}
      error={pickerError}
      onSelect={fragment => {
        if (!picker) return
        if (picker.mode === "add") addRequirement(fragment, picker.material)
        else {
          const requirement = value.requirements.find(item => item.requirementId === picker.requirementId)
          if (requirement) changeSource(requirement, fragment, picker.material.snapshotId ?? "")
        }
        setPicker(null)
      }}
    />
  </section>
}

function conditionOf(requirement: VerificationRequirement): RequirementCondition {
  if (requirement.field && requirement.operator) {
    return { field: requirement.field, operator: requirement.operator, value: requirement.value ?? "" }
  }
  return { field: "subject_name", operator: "eq", value: "" }
}

/** Exported for the result panel's read-only requirement table. */
export function RequirementTable({ value, materials }: { value: RequirementSetValue; materials: readonly VerificationMaterial[] }) {
  return <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>要求</TableHead><TableHead>义务主体</TableHead><TableHead>性质</TableHead><TableHead>比较条件</TableHead><TableHead>状态</TableHead><TableHead>来源</TableHead></TableRow></TableHeader><TableBody>
    {value.requirements.map(requirement => <TableRow key={requirement.requirementId}>
      <TableCell className="whitespace-normal"><p className="font-medium">{requirement.requirementId}</p><p className="max-w-md break-words text-xs text-muted-foreground">{requirement.quote}</p></TableCell>
      <TableCell className="whitespace-normal">{requirement.subject || "未标注"}</TableCell>
      <TableCell className="whitespace-normal">{requirement.nature}</TableCell>
      <TableCell className="whitespace-normal">{requirementExpressionLabel(requirement)}</TableCell>
      <TableCell>{requirement.status === "confirmed" ? "已确认" : "待确认"}</TableCell>
      <TableCell className="max-w-xs whitespace-normal break-words text-xs text-muted-foreground">{requirementSourceLabel(requirement, materials)}</TableCell>
    </TableRow>)}
  </TableBody></Table></div>
}
