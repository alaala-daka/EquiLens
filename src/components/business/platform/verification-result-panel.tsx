"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ArrowDownToLineIcon } from "lucide-react"
import type { ExportRef, ResultReview, ResultValidation } from "@/lib/business/contracts"
import type { BidVerificationValue, RequirementSetValue } from "@/lib/business/verification-types"
import type { VerificationDetail, VerificationMaterial, VerificationResultView } from "@/lib/business/verifications-client"
import { RequirementTable } from "./verification-requirement-editor"
import {
  bidVerificationValue, comparisonReadiness, couldExport, coverageSummaryLabel,
  externalCheckTone, externalStatusIsPass, materialCheckTone, materialTitle, requirementSetCounts,
  requirementSetStatusLabel, requirementSetValue, resultKindLabel, reviewActionAvailability,
  reviewDecisionLabel, staleHint, validationStatusLabel, verificationExportBaseName, verificationItemRows,
} from "./verification-state"
import { formatReviewTime } from "./review-state"

export type VerificationPanelBusy = "validate" | "review" | "export" | "download" | null

/**
 * Read/review panel for one saved requirement set or comparison result.
 *
 * The two comparison status dimensions are shown as independent columns: a
 * material pass never implies external authenticity and vice versa. Invalid
 * results stay readable/reviewable for audit but cannot be approved or
 * exported; requirement sets have no Word export.
 */
export function VerificationResultPanel({ result, detail, materials, canEdit, busy, error, validation, reviewComment, onReviewCommentChange, onValidate, onReview, onCreateExport, onDownloadExport, onEditRequirements, onRefresh, exports, exportsError }: {
  result: VerificationResultView
  detail: VerificationDetail | null
  materials: readonly VerificationMaterial[]
  canEdit: boolean
  busy: VerificationPanelBusy
  error: string
  validation: ResultValidation
  reviewComment: string
  onReviewCommentChange(value: string): void
  onValidate(): void
  onReview(decision: ResultReview["decision"]): void
  onCreateExport(): void
  onDownloadExport(exportRef: ExportRef): void
  onEditRequirements(value: RequirementSetValue): void
  onRefresh(): void
  exports: readonly ExportRef[]
  exportsError: string
}) {
  const isComparison = result.kind === "bid-verification"
  const requirementValue = isComparison ? null : requirementSetValue(result.value)
  const comparisonValue: BidVerificationValue | null = isComparison ? bidVerificationValue(result.value) : null
  const availability = reviewActionAvailability(canEdit, validation, result.review)
  const exportState = couldExport(canEdit, result.kind, validation)
  const actionsDisabled = busy !== null
  const stale = detail?.stale ?? null
  const rows = comparisonValue ? verificationItemRows(comparisonValue) : []
  const counts = requirementValue ? requirementSetCounts(requirementValue) : null
  const readiness = requirementValue ? comparisonReadiness(requirementValue) : null
  return <section aria-label="核验成果" className="flex flex-col gap-4 rounded-lg border p-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{resultKindLabel(result.kind)}</h3>
          <Badge variant="outline">{result.origin === "machine" ? "机器成果" : "人工成果"}</Badge>
          <Badge variant={validation.status === "valid" ? "default" : validation.status === "partial" ? "secondary" : "destructive"}>{validationStatusLabel(validation.status)}</Badge>
          <Badge variant={result.review?.decision === "approved" ? "default" : "secondary"}>{reviewDecisionLabel(result.review)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">生成时间：{formatReviewTime(result.createdAt)} · 校验时间：{formatReviewTime(validation.checkedAt)}</p>
        {stale?.hint && <p role="status" className="text-sm">{staleHint(stale)}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={actionsDisabled} onClick={onRefresh}>刷新</Button>
        {!isComparison && <Button type="button" variant="outline" size="sm" disabled={actionsDisabled || !canEdit || !requirementValue} onClick={() => requirementValue && onEditRequirements(requirementValue)}>编辑要求集</Button>}
        <Button type="button" variant="outline" size="sm" disabled={actionsDisabled} onClick={onValidate}>{busy === "validate" ? "正在校验" : "重新校验"}</Button>
        {canEdit && <Button type="button" size="sm" disabled={actionsDisabled || !availability.canApprove} onClick={() => onReview("approved")}>{busy === "review" ? "正在记录" : "批准"}</Button>}
        {canEdit && <Button type="button" variant="outline" size="sm" disabled={actionsDisabled || !availability.canReject} onClick={() => onReview("rejected")}>驳回</Button>}
        {isComparison && <Button type="button" size="sm" disabled={actionsDisabled || !exportState.canExport} onClick={onCreateExport}>{busy === "export" ? "正在生成导出" : "导出 Word"}</Button>}
      </div>
    </header>
    {validation.issues.length > 0 && <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium">校验未通过项（{validation.issues.length}）</p>
      <ul className="list-disc space-y-1 pl-4">{validation.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="break-words">{issue.message}</li>)}</ul>
    </div>}
    {canEdit && !availability.canApprove && availability.approveHint && <p className="text-sm text-muted-foreground">{availability.approveHint}</p>}
    {canEdit && isComparison && !exportState.canExport && exportState.hint && <p className="text-sm text-muted-foreground">{exportState.hint}</p>}
    {canEdit && <label className="grid max-w-2xl gap-2 text-sm">复核意见<Textarea value={reviewComment} maxLength={1000} disabled={actionsDisabled} placeholder="驳回时必填；通过时可填写说明。" onChange={event => onReviewCommentChange(event.target.value)} /></label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result.review && <div className="space-y-1 rounded-md border p-3 text-sm">
      <p className="font-medium">复核记录：{reviewDecisionLabel(result.review)} · {formatReviewTime(result.review.reviewedAt)}</p>
      {result.review.comment && <p className="break-words">意见：{result.review.comment}</p>}
    </div>}

    {!isComparison && !requirementValue && <p role="alert" className="text-sm text-destructive">要求集内容无法读取，请重新校验或刷新。</p>}
    {requirementValue && counts && <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{requirementSetStatusLabel(requirementValue)}</Badge><span className="text-sm">共 {counts.total} 条 · 已确认 {counts.confirmed} 条 · 待确认 {counts.pending} 条 · 性质待确认 {counts.pendingNature} 条 · 驳回 {counts.rejected} 条</span></div>
      {readiness && !readiness.ready && <p role="status" className="text-sm">{readiness.reason}</p>}
      {requirementValue.warnings.length > 0 && <div role="status" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">{requirementValue.warnings.map((warning, index) => <p key={index} className="break-words">{warning}</p>)}</div>}
      {requirementValue.errors.length > 0 && <div role="alert" className="space-y-1 rounded-md border p-3 text-sm text-destructive">{requirementValue.errors.map((entry, index) => <p key={index} className="break-words">{entry.code}：{entry.message}</p>)}</div>}
      <RequirementTable value={requirementValue} materials={materials} />
      {requirementValue.rejected.length > 0 && <Collapsible>
        <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">驳回记录（{requirementValue.rejected.length}）</Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-3">{requirementValue.rejected.map((entry, index) => <p key={index} className="break-words text-sm">{entry.reason} · 原引文：{entry.quote || "未记录"}</p>)}</CollapsibleContent>
      </Collapsible>}
    </div>}

    {isComparison && !comparisonValue && <p role="alert" className="text-sm text-destructive">核验结果内容无法读取，请重新校验或刷新。</p>}
    {comparisonValue && <div className="space-y-4">
      <p className="text-sm">{coverageSummaryLabel(comparisonValue)}</p>
      <p className="text-sm">判定日期：{comparisonValue.asOf} · 执行状态：{comparisonValue.status === "success" ? "比较完成" : "部分完成（存在待确认要求）"}</p>
      <p role="note" className="text-sm text-muted-foreground">材料检查与外部真实性两组状态独立；外部未核验、未查到、查询失败均不构成真实性通过。</p>
      {rows.length === 0 ? <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><ArrowDownToLineIcon /></EmptyMedia><EmptyTitle>暂无可比较条目</EmptyTitle></EmptyHeader></Empty> : <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>要求</TableHead><TableHead>义务主体</TableHead><TableHead>材料检查</TableHead><TableHead>外部真实性</TableHead><TableHead>判定说明与证据</TableHead></TableRow></TableHeader><TableBody>
        {rows.map(row => <TableRow key={row.item.requirementId}>
          <TableCell className="max-w-sm whitespace-normal"><p className="font-medium">{row.item.requirementId}</p><p className="break-words text-xs text-muted-foreground">{row.quote}</p></TableCell>
          <TableCell className="whitespace-normal">{row.subject}</TableCell>
          <TableCell><Badge variant={materialCheckTone(row.item.materialCheck)}>{row.materialCheck}</Badge></TableCell>
          <TableCell className="space-y-1"><Badge variant={externalCheckTone(row.item.externalCheck)}>{row.item.externalCheck}</Badge>{!externalStatusIsPass(row.item.externalCheck) && <p className="text-xs text-muted-foreground">非真实性通过</p>}</TableCell>
          <TableCell className="max-w-md whitespace-normal break-words text-sm"><p>{row.item.detail}</p><p className="text-xs text-muted-foreground">{row.evidenceLabel}</p></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
      {comparisonValue.unfinished.length > 0 && <div className="space-y-1 rounded-md border p-3 text-sm">
        <p className="font-medium">未完成事项（{comparisonValue.unfinished.length} 项）</p>
        {comparisonValue.unfinished.map(item => <p key={item.requirementId} className="break-words">{item.requirementId}：{item.reason}</p>)}
      </div>}
      {comparisonValue.warnings.length > 0 && <div role="status" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">{comparisonValue.warnings.map((warning, index) => <p key={index} className="break-words">{warning}</p>)}</div>}
      {comparisonValue.errors.length > 0 && <div role="alert" className="space-y-1 rounded-md border p-3 text-sm text-destructive">{comparisonValue.errors.map((entry, index) => <p key={index} className="break-words">{entry.code}：{entry.message}</p>)}</div>}
      <Collapsible>
        <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">比较材料与记录快照（{comparisonValue.materials.length} 份材料 / {comparisonValue.records.length} 条记录）</Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-3 text-sm">
          {comparisonValue.materials.map(material => <p key={material.versionId} className="break-all">{materialTitle(materials, material.versionId)} · 版本 {material.versionId} · 摘要 {material.sha256.slice(0, 12)}</p>)}
          {comparisonValue.records.map(record => <p key={record.recordId} className="break-words">{record.requirementId} · {record.source} · {record.queriedAt} · {record.subject} / {record.certificateNo}</p>)}
          {comparisonValue.records.length === 0 && <p className="text-muted-foreground">未引用外部核验记录</p>}
        </CollapsibleContent>
      </Collapsible>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">已有导出</h4>
        {exportsError && <p role="alert" className="text-sm text-destructive">{exportsError}</p>}
        {exports.length === 0 ? <p className="text-sm text-muted-foreground">暂无导出</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>生成时间</TableHead><TableHead>格式</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {exports.map(exportRef => <TableRow key={exportRef.exportId}>
            <TableCell className="whitespace-normal">{formatReviewTime(exportRef.createdAt)}</TableCell>
            <TableCell>{exportRef.format.toUpperCase()}</TableCell>
            <TableCell><Button type="button" variant="link" disabled={actionsDisabled} onClick={() => onDownloadExport(exportRef)}>下载 {verificationExportBaseName()}</Button></TableCell>
          </TableRow>)}
        </TableBody></Table></div>}
      </div>
    </div>}
  </section>
}
