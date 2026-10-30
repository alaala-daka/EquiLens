"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { FileBadgeIcon } from "lucide-react"
import type { SnapshotFragment } from "@/lib/business/materials-client"
import type { RequirementSnapshot, VerificationExternalRecordView } from "@/lib/business/verification-types"
import type { VerificationFieldView, VerificationMaterial } from "@/lib/business/verifications-client"
import {
  conclusionOptions, evidenceMaterial, fieldKeyOptions, fieldSourceLabel, fieldTypeLabels,
  fragmentLocationLabel, fragmentPreview, materialTitle, supportLabels,
} from "./verification-state"
import type { ExternalRecordForm, FieldForm } from "./verification-state"

/**
 * Certificate field read/registration panel.
 *
 * Current values, OCR originals and the insert-only correction history stay
 * distinct. A manual value only becomes material-supported when it cites a
 * fragment of the same material version verbatim; otherwise it is stored as
 * 待确认 by the server. Field registration never implies certificate authenticity.
 */
export function VerificationFieldPanel({ materials, materialId, onMaterialChange, fields, history, loading, error, canEdit, busy, form, onFormChange, onSubmit, formIssues, sourceFragment, sourceFragmentError, onPickSourceFragment, onClearSourceFragment, onCorrect, onRefresh }: {
  materials: readonly VerificationMaterial[]
  materialId: string
  onMaterialChange(materialId: string): void
  fields: readonly VerificationFieldView[]
  history: readonly VerificationFieldView[]
  loading: boolean
  error: string
  canEdit: boolean
  busy: boolean
  form: FieldForm
  onFormChange(form: FieldForm): void
  onSubmit(): void
  formIssues: readonly string[]
  sourceFragment: SnapshotFragment | null
  sourceFragmentError: string
  onPickSourceFragment(): void
  onClearSourceFragment(): void
  onCorrect(view: VerificationFieldView): void
  onRefresh(): void
}) {
  const selectable = materials.filter(evidenceMaterial)
  const selected = materials.find(material => material.id === materialId) ?? null
  const selectedType = fieldTypeLabels[fieldKeyOptions().find(option => option.value === form.fieldKey)?.type ?? "text"] ?? "文本"
  return <section aria-label="证照字段" className="flex flex-col gap-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold">证照字段</h3>
      <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={onRefresh}>刷新</Button>
    </div>
    <label className="grid max-w-xl gap-2 text-sm">材料版本<NativeSelect value={materialId} disabled={busy} onChange={event => onMaterialChange(event.target.value)}><NativeSelectOption value="">请选择证照信息材料</NativeSelectOption>{selectable.map(material => <NativeSelectOption key={material.id} value={material.id}>{material.title}（{material.format.toUpperCase()}）</NativeSelectOption>)}</NativeSelect></label>
    {selected && <p className="text-xs text-muted-foreground">{selected.format === "image" ? "图片材料：字段由 OCR 识别；人工更正无解析片段时保存为待确认。" : selected.snapshotId ? "文档材料：人工登记可引用同版本解析片段以取得材料原文支持。" : "该材料暂无解析快照。"}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!materialId ? <p role="status" className="text-sm text-muted-foreground">请选择材料版本以读取证照字段</p> : loading ? <p role="status" className="text-sm text-muted-foreground">正在读取证照字段</p> : fields.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileBadgeIcon /></EmptyMedia><EmptyTitle>暂无证照字段</EmptyTitle></EmptyHeader></Empty> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>字段</TableHead><TableHead>值</TableHead><TableHead>来源</TableHead><TableHead>材料支持</TableHead><TableHead>来源片段</TableHead><TableHead>更新时间</TableHead>{canEdit && <TableHead>操作</TableHead>}</TableRow></TableHeader><TableBody>
      {fields.map(field => <TableRow key={field.id}>
        <TableCell className="whitespace-normal"><p>{field.label}</p><p className="text-xs text-muted-foreground">{field.subjectKey}</p></TableCell>
        <TableCell className="whitespace-normal break-words">{field.valueText}{field.normalizedValue && field.normalizedValue !== field.valueText && <p className="text-xs text-muted-foreground">归一化：{field.normalizedValue}</p>}</TableCell>
        <TableCell className="whitespace-normal">{fieldSourceLabel(field)}</TableCell>
        <TableCell><Badge variant={field.support === "ocr" ? "default" : field.support === "material_text" ? "secondary" : "outline"}>{supportLabels[field.support] ?? field.support}</Badge></TableCell>
        <TableCell className="max-w-40 whitespace-normal break-words text-xs text-muted-foreground">{field.sourceFragmentId ? field.sourceFragmentId.slice(0, 8) : "无"}</TableCell>
        <TableCell className="whitespace-normal text-xs">{field.createdAt ? new Date(field.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</TableCell>
        {canEdit && <TableCell><Button type="button" variant="link" size="sm" disabled={busy} onClick={() => onCorrect(field)}>更正</Button></TableCell>}
      </TableRow>)}
    </TableBody></Table></div>}
    {materialId && <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">更正历史（{history.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">
        {history.length === 0 ? <p className="text-sm text-muted-foreground">暂无更正历史</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>字段</TableHead><TableHead>原值</TableHead><TableHead>来源</TableHead><TableHead>更正理由</TableHead><TableHead>更正时间</TableHead></TableRow></TableHeader><TableBody>
          {history.map(record => <TableRow key={record.id}>
            <TableCell className="whitespace-normal">{record.label}（{record.subjectKey}）</TableCell>
            <TableCell className="whitespace-normal break-words">{record.valueText}</TableCell>
            <TableCell>{record.origin === "ocr" ? "OCR 识别原值" : record.origin === "material_text" ? "材料原文支持" : "人工登记"}</TableCell>
            <TableCell className="max-w-56 whitespace-normal break-words text-xs">{record.reason || "未填写"}</TableCell>
            <TableCell className="whitespace-normal text-xs">{record.createdAt ? new Date(record.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</TableCell>
          </TableRow>)}
        </TableBody></Table></div>}
      </CollapsibleContent>
    </Collapsible>}
    {canEdit && materialId && <form aria-label="登记证照字段" className="flex flex-col gap-3 rounded-md border p-3" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <p className="text-sm font-medium">人工登记或更正字段</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-sm">字段<NativeSelect value={form.fieldKey} disabled={busy} onChange={event => onFormChange({ ...form, fieldKey: event.target.value as FieldForm["fieldKey"] })}>{fieldKeyOptions().map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}（{option.type}）</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm">主体标识<Input value={form.subjectKey} maxLength={64} disabled={busy} placeholder="enterprise" onChange={event => onFormChange({ ...form, subjectKey: event.target.value })} /></label>
        <label className="grid gap-2 text-sm md:col-span-2">字段值（{selectedType}）<Input value={form.valueText} maxLength={2000} disabled={busy} onChange={event => onFormChange({ ...form, valueText: event.target.value })} /></label>
        <label className="grid gap-2 text-sm md:col-span-2">更正理由<Input value={form.reason} maxLength={500} disabled={busy} placeholder="更正已有字段时必填" onChange={event => onFormChange({ ...form, reason: event.target.value })} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy || !selected?.snapshotId} onClick={onPickSourceFragment}>选择来源片段</Button>
        {form.sourceFragmentId && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClearSourceFragment}>清除来源</Button>}
        <span className="text-xs text-muted-foreground">{form.sourceFragmentId ? `已选来源片段 ${form.sourceFragmentId.slice(0, 8)}` : "未选择来源片段时，人工值仅保存为待确认。"}</span>
      </div>
      {sourceFragment && <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm"><p className="text-xs text-muted-foreground">{fragmentLocationLabel(sourceFragment)}</p><p className="whitespace-pre-wrap break-words">{fragmentPreview(sourceFragment, 240)}</p></div>}
      {sourceFragmentError && <p role="alert" className="text-sm text-destructive">{sourceFragmentError}</p>}
      {formIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{formIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
      <Button type="submit" disabled={busy} className="w-fit">{busy ? "正在保存字段" : "保存字段"}</Button>
    </form>}
    {!canEdit && <p role="note" className="text-sm text-muted-foreground">只读成员可查看证照字段及更正历史，不能登记或更正。</p>}
  </section>
}

/**
 * External-verification record panel (append-only manual evidence).
 *
 * The record pins source/time/operator(via current account)/conditions/
 * conclusion/proof version on the server. An unmatched, not-found or failed
 * query never becomes a material or authenticity pass.
 */
export function VerificationRecordPanel({ canEdit, busy, error, records, requirements, form, onFormChange, onRequirementChange, onSubmit, formIssues, materials, staleHintText, onRefresh }: {
  canEdit: boolean
  busy: boolean
  error: string
  records: readonly VerificationExternalRecordView[]
  requirements: readonly RequirementSnapshot[]
  form: ExternalRecordForm
  onFormChange(form: ExternalRecordForm): void
  onRequirementChange(requirementId: string): void
  onSubmit(): void
  formIssues: readonly string[]
  materials: readonly VerificationMaterial[]
  staleHintText: string
  onRefresh(): void
}) {
  const proofMaterials = materials
  return <section aria-label="外部核验记录" className="flex flex-col gap-4 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold">外部核验记录</h3>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRefresh}>刷新</Button>
    </div>
    <p role="note" className="text-sm text-muted-foreground">外部真实性仅记录人工查询证据；未核验、未查到、查询失败均不构成真实性通过。核验人为当前操作账号，由服务端记录。</p>
    {staleHintText && <p role="status" className="text-sm">{staleHintText}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {records.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileBadgeIcon /></EmptyMedia><EmptyTitle>暂无外部核验记录</EmptyTitle></EmptyHeader></Empty> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>要求</TableHead><TableHead>结论</TableHead><TableHead>查询来源</TableHead><TableHead>查询时间</TableHead><TableHead>查询条件</TableHead><TableHead>查询主体 / 证号</TableHead><TableHead>证明材料版本</TableHead><TableHead>记录摘要</TableHead></TableRow></TableHeader><TableBody>
      {records.map(record => <TableRow key={record.recordId}>
        <TableCell className="whitespace-normal">{record.requirementId}</TableCell>
        <TableCell><Badge variant={record.conclusion === "matched" ? "default" : record.conclusion === "conflict" ? "destructive" : "outline"}>{conclusionOptions.find(option => option.value === record.conclusion)?.label ?? record.conclusion}</Badge></TableCell>
        <TableCell className="max-w-40 whitespace-normal break-words">{record.source}</TableCell>
        <TableCell className="whitespace-normal text-xs">{record.queriedAt}</TableCell>
        <TableCell className="max-w-40 whitespace-normal break-words text-xs">{record.queryConditions}</TableCell>
        <TableCell className="max-w-40 whitespace-normal break-words text-xs">{record.subject} / {record.certificateNo}</TableCell>
        <TableCell className="max-w-32 whitespace-normal break-words text-xs">{materialTitle(materials, record.proofMaterialVersionId)}</TableCell>
        <TableCell className="whitespace-normal break-all text-xs">{record.sha256.slice(0, 12)}</TableCell>
      </TableRow>)}
    </TableBody></Table></div>}
    {canEdit && <form aria-label="追加外部核验记录" className="flex flex-col gap-3 rounded-md border p-3" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <p className="text-sm font-medium">追加外部核验记录</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-sm">对应要求<NativeSelect value={form.requirementId} disabled={busy} onChange={event => onRequirementChange(event.target.value)}><NativeSelectOption value="">请选择要求</NativeSelectOption>{requirements.map(requirement => <NativeSelectOption key={requirement.requirementId} value={requirement.requirementId}>{requirement.requirementId} · {requirement.subject || "未标注主体"}</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm">查询主体<Input value={form.subject} maxLength={200} disabled={busy} onChange={event => onFormChange({ ...form, subject: event.target.value })} /></label>
        <label className="grid gap-2 text-sm">证号<Input value={form.certificateNo} maxLength={128} disabled={busy} onChange={event => onFormChange({ ...form, certificateNo: event.target.value })} /></label>
        <label className="grid gap-2 text-sm">查询来源<Input value={form.source} maxLength={500} disabled={busy} placeholder="如：全国建筑市场监管公共服务平台" onChange={event => onFormChange({ ...form, source: event.target.value })} /></label>
        <label className="grid gap-2 text-sm">查询时间<Input type="datetime-local" value={form.queriedAt} disabled={busy} onChange={event => onFormChange({ ...form, queriedAt: event.target.value })} /></label>
        <label className="grid gap-2 text-sm">查询结论<NativeSelect value={form.conclusion} disabled={busy} onChange={event => onFormChange({ ...form, conclusion: event.target.value as ExternalRecordForm["conclusion"] })}><NativeSelectOption value="">请选择结论</NativeSelectOption>{conclusionOptions.map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}</NativeSelect></label>
        <label className="grid gap-2 text-sm md:col-span-2">查询条件<Textarea value={form.queryConditions} maxLength={500} disabled={busy} placeholder="填写查询条件，如主体名称、证号、判定日期与查询方式" onChange={event => onFormChange({ ...form, queryConditions: event.target.value })} /></label>
        <label className="grid gap-2 text-sm md:col-span-2">证明材料版本<NativeSelect value={form.proofMaterialVersionId} disabled={busy} onChange={event => onFormChange({ ...form, proofMaterialVersionId: event.target.value })}><NativeSelectOption value="">请选择本项目内的证明材料版本</NativeSelectOption>{proofMaterials.map(material => <NativeSelectOption key={material.id} value={material.versionId}>{material.title}（{material.format.toUpperCase()}）</NativeSelectOption>)}</NativeSelect></label>
      </div>
      {formIssues.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">{formIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
      <Button type="submit" disabled={busy} className="w-fit">{busy ? "正在保存核验记录" : "追加核验记录"}</Button>
    </form>}
    {!canEdit && <p role="note" className="text-sm text-muted-foreground">只读成员可查看外部核验记录，不能追加记录。</p>}
  </section>
}
