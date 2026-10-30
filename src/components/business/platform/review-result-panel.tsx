"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ExportRef, ResultReview, ResultValidation } from "@/lib/business/contracts"
import type { ProjectResultView } from "@/lib/business/reviews-client"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { ReviewReportView } from "./review-report-view"
import {
  exportAvailability,
  formatReviewTime,
  reviewActionAvailability,
  reviewDecisionLabel,
  validationStatusLabel,
} from "./review-state"

export type ReviewPanelBusy = "validate" | "review" | "export" | "download" | null

/**
 * Project result actions for one explicit saved version (B2a): revalidate,
 * human approve/reject and versioned Word export. It never edits findings or
 * calls a model; approve stays blocked while the server-side validation of the
 * same version is not valid.
 */
export function ReviewResultPanel({ result, value, validation, exports, exportsError, canEdit, busy, error, onValidate, onReview, onCreateExport, onDownloadExport }: {
  result: ProjectResultView
  value: ReviewResult | null
  validation: ResultValidation
  exports: ExportRef[]
  exportsError: string
  canEdit: boolean
  busy: ReviewPanelBusy
  error: string
  onValidate(): void
  onReview(decision: ResultReview["decision"], comment: string): void
  onCreateExport(): void
  onDownloadExport(exportRef: ExportRef): void
}) {
  const [comment, setComment] = useState("")
  const [commentError, setCommentError] = useState("")
  const [reportOpen, setReportOpen] = useState(false)
  const availability = reviewActionAvailability(canEdit, validation, result.review)
  const exportState = exportAvailability(canEdit, validation)
  const title = value?.documentTitle.trim() || "合同审查"
  const reject = () => {
    const reason = comment.trim()
    if (!reason) { setCommentError("驳回需填写复核意见。"); return }
    setCommentError("")
    onReview("rejected", reason)
  }
  const approve = () => {
    setCommentError("")
    onReview("approved", comment.trim())
  }
  const actionsDisabled = busy !== null
  return <section aria-label="审查成果" className="flex flex-col gap-4 rounded-lg border p-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{title}</h3>
          <Badge variant={result.origin === "machine" ? "outline" : "secondary"}>{result.origin === "machine" ? "机器成果" : "人工修订成果"}</Badge>
          <Badge variant={validation.status === "valid" ? "default" : "destructive"}>{validationStatusLabel(validation.status)}</Badge>
          <Badge variant={result.review?.decision === "approved" ? "default" : "secondary"}>{reviewDecisionLabel(result.review)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">版本生成时间：{formatReviewTime(result.createdAt)} · 校验时间：{formatReviewTime(validation.checkedAt)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {value && <Button type="button" variant="outline" size="sm" onClick={() => setReportOpen(true)}>展开报告</Button>}
        <Button type="button" variant="outline" size="sm" disabled={actionsDisabled} onClick={onValidate}>{busy === "validate" ? "正在校验" : "重新校验"}</Button>
        {canEdit && <Button type="button" size="sm" disabled={actionsDisabled || !availability.canApprove} onClick={approve}>{busy === "review" ? "正在记录" : "批准"}</Button>}
        {canEdit && <Button type="button" variant="outline" size="sm" disabled={actionsDisabled || !availability.canReject} onClick={reject}>驳回</Button>}
        {canEdit && <Button type="button" size="sm" disabled={actionsDisabled || !exportState.canExport} onClick={onCreateExport}>{busy === "export" ? "正在生成导出" : "导出 Word"}</Button>}
      </div>
    </header>
    {value?.mode === "debug" && <p role="note" className="text-sm">审查依据尚未签核，结果需人工复核。</p>}
    <p role="note" className="text-sm text-muted-foreground">机器审查结论不代表合同无风险；复核针对当前明确保存的成果版本。</p>
    {canEdit && !availability.canApprove && availability.approveHint && <p className="text-sm text-muted-foreground">{availability.approveHint}</p>}
    {canEdit && !exportState.canExport && exportState.exportHint && <p className="text-sm text-muted-foreground">{exportState.exportHint}</p>}
    {validation.issues.length > 0 && <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium">校验未通过项（{validation.issues.length}）</p>
      <ul className="list-disc space-y-1 pl-4">{validation.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="break-words">{issue.message}</li>)}</ul>
    </div>}
    {result.review && <div className="space-y-1 rounded-md border p-3 text-sm">
      <p className="font-medium">复核记录：{reviewDecisionLabel(result.review)} · {formatReviewTime(result.review.reviewedAt)}</p>
      {result.review.comment && <p className="break-words">意见：{result.review.comment}</p>}
    </div>}
    {canEdit && <label className="grid max-w-2xl gap-2 text-sm">复核意见<Textarea value={comment} maxLength={1000} disabled={actionsDisabled} placeholder="驳回时必填；通过时可填写说明。" onChange={event => { setComment(event.target.value); setCommentError("") }} />{commentError && <span role="alert" className="text-sm text-destructive">{commentError}</span>}</label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {value ? <ReviewReportView result={value} /> : <p role="alert" className="text-sm text-destructive">成果内容无法读取，请重新校验或重新读取成果。</p>}
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">已有导出</h4>
      {exportsError && <p role="alert" className="text-sm text-destructive">{exportsError}</p>}
      {exports.length === 0 ? <p className="text-sm text-muted-foreground">暂无导出</p> : <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>生成时间</TableHead><TableHead>格式</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {exports.map(exportRef => <TableRow key={exportRef.exportId}>
          <TableCell className="whitespace-normal">{formatReviewTime(exportRef.createdAt)}</TableCell>
          <TableCell>{exportRef.format.toUpperCase()}</TableCell>
          <TableCell><Button type="button" variant="link" disabled={actionsDisabled} onClick={() => onDownloadExport(exportRef)}>下载</Button></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
    </div>
    <AlertDialog open={reportOpen} onOpenChange={setReportOpen}>
      <AlertDialogContent size="lg" className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader><AlertDialogTitle>完整审查报告</AlertDialogTitle></AlertDialogHeader>
        {value && <ReviewReportView result={value} />}
        <AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
}
