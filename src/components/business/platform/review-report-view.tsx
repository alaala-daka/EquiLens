"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { CATEGORY_LABELS, compactText, getReportView } from "../../../../tools/contract-review/src/presentation"
import { reviewSceneLabel } from "./review-state"

/**
 * Project contract-review report (B2a).
 *
 * Presentational only: it reuses the established anonymous report conventions
 * (scene, six categories, expandable findings, unfinished checks, machine
 * review notes) but imports no anonymous session logic: no task submission,
 * no revision flow and no browser-side export. Validation, review and the
 * versioned Word export stay in the surrounding result panel so they always
 * act on one explicit saved version.
 */

type Finding = ReviewResult["findings"][number]

function severityOrder(severity: Finding["severity"]): number {
  return severity === "重大关注" ? 0 : severity === "一般关注" ? 1 : 2
}

function SeverityBadge({ severity }: { severity: Finding["severity"] }) {
  return <Badge variant={severity === "重大关注" ? "destructive" : severity === "一般关注" ? "default" : "secondary"}>{severity.replace("关注", "")}</Badge>
}

function Citation({ result, index, quote }: { result: ReviewResult; index: number; quote: string }) {
  const paragraph = result.paragraphs.find(item => item.index === index)
  const offset = paragraph?.text.indexOf(quote) ?? -1
  return <AlertDialog>
    <AlertDialogTrigger asChild><Button type="button" variant="link" className="h-auto px-0">查看第 {index + 1} 段原文</Button></AlertDialogTrigger>
    <AlertDialogContent className="max-h-svh overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle>引用原文 · 第 {index + 1} 段</AlertDialogTitle>
        <AlertDialogDescription>来自本次成果对应的保存解析快照。</AlertDialogDescription>
      </AlertDialogHeader>
      {paragraph?.table && <p className="text-sm text-muted-foreground">表 {paragraph.table.index}，第 {paragraph.table.row} 行，第 {paragraph.table.column} 列</p>}
      {paragraph && offset >= 0 ? <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">
        {paragraph.text.slice(0, offset)}<mark>{paragraph.text.slice(offset, offset + quote.length)}</mark>{paragraph.text.slice(offset + quote.length)}
      </blockquote> : <p role="alert" className="text-sm text-destructive">引文与保存的解析快照不匹配。</p>}
      <AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

function FindingDetail({ finding, result }: { finding: Finding; result: ReviewResult }) {
  const citations = finding.citations ?? (finding.quote ? [{ paragraphIndex: finding.paragraphIndex, quote: finding.quote }] : [])
  const audit = result.collaboration?.audit?.checks.find(item => item.ruleId === finding.ruleId)
  const confirmations = getReportView(result).confirmations.filter(item => item.ruleIds.includes(finding.ruleId)).map(item => item.text)
  return <article className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={finding.severity} />{audit?.outcome === "需人工核对" && <Badge variant="outline">复查有疑点</Badge>}{finding.kind === "待核实" && <Badge variant="outline">待核实</Badge>}</div>
    <p className="break-words text-sm font-medium">{compactText(finding.risk, 80)}</p>
    {finding.impact && <p className="break-words text-sm">风险影响：{finding.impact}</p>}
    <p className="break-words text-sm">修改建议：{finding.suggestion}</p>
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm" className="w-fit">展开原文、解释与依据<span className="sr-only">：{finding.category} · {finding.ruleId}</span></Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{finding.ruleId} · {finding.reviewStatus}</span></div>
        <p className="whitespace-pre-wrap break-words text-sm">具体问题：{finding.risk}</p>
        {finding.quote && <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">{finding.quote}</blockquote>}
        {finding.kind === "缺失条款" && !finding.quote && <p className="text-sm">已读取的合同内容中未找到对应条款。</p>}
        {citations.map((citation, index) => <div key={index}><Citation result={result} index={citation.paragraphIndex} quote={citation.quote} /></div>)}
        {finding.kind === "缺失条款" && <p className="text-sm text-muted-foreground">已检查 {finding.checkedParagraphIndexes?.length ?? 0} 段正文。</p>}
        {finding.impact && <p className="break-words text-sm">为什么需要关注：{finding.impact}</p>}
        <p className="whitespace-pre-wrap break-words text-sm">建议如何修改：{finding.suggestion}</p>
        {confirmations.length > 0 && <p className="whitespace-pre-wrap break-words text-sm">需要确认：{confirmations.join("；")}</p>}
        {finding.sourceReferences?.length ? <ul className="space-y-2 text-sm text-muted-foreground">{finding.sourceReferences.map(source => <li key={source.sourceId}>
          {source.type}：{source.name} {source.article} {source.version} · {source.status}
          {source.officialUrl?.startsWith("https://") && <> · <a className="underline" href={source.officialUrl} target="_blank" rel="noreferrer">来源</a></>}
        </li>)}</ul> : finding.basis.length > 0 ? <p className="break-words text-sm text-muted-foreground">依据：{finding.basis.join("、")}</p> : null}
        {result.collaboration && <div className="space-y-2 text-sm"><p className="font-medium">AI 复查意见</p>
          <p className="break-words">{audit ? audit.note : "此项尚未完成 AI 复查。"}</p>
          {audit?.quote && <Citation result={result} index={audit.paragraphIndex} quote={audit.quote} />}
          {audit && <p className="text-xs text-muted-foreground">{audit.outcome} · 机器意见，仍需人工复核</p>}
        </div>}
      </CollapsibleContent>
    </Collapsible>
  </article>
}

function SceneIdentification({ result }: { result: ReviewResult }) {
  const selection = result.sceneSelection
  if (!selection) return null
  const candidate = result.sceneCandidates?.find(item => item.id === selection.sceneId)
  const title = selection.status === "matched" ? "审查场景：" + (candidate?.label ?? selection.sceneId)
    : selection.status === "unsupported" ? "场景不支持" : "场景待确认"
  return <section aria-label="场景识别" className="flex flex-col gap-3">
    {selection.status !== "matched" && <><h3 className="text-sm font-semibold">{title}</h3><p className="break-words text-sm">{selection.reason}</p></>}
    {selection.missingInfo.length > 0 && <ul className="list-disc space-y-1 pl-4 text-sm">{selection.missingInfo.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">场景识别依据</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{selection.status === "matched" && <p className="break-words text-sm">{selection.reason}</p>}{selection.evidence.map((item, index) => <div key={index} className="space-y-2">
        <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">{item.quote}</blockquote>
        <Citation result={result} index={item.paragraphIndex} quote={item.quote} />
      </div>)}</CollapsibleContent>
    </Collapsible>
  </section>
}

function IndependentAudit({ result }: { result: ReviewResult }) {
  const collaboration = result.collaboration
  if (!collaboration) return null
  const audit = collaboration.audit
  const flagged = audit?.checks.filter(item => item.outcome === "需人工核对") ?? []
  const clear = audit?.checks.filter(item => item.outcome === "保留") ?? []
  const check = (item: NonNullable<typeof audit>["checks"][number]) => <article key={item.ruleId} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
    <p className="font-medium">{item.ruleId} · {item.outcome}</p>
    <p className="break-words">{item.note}</p>
    {item.quote && <Citation result={result} index={item.paragraphIndex} quote={item.quote} />}
    <p className="text-xs text-muted-foreground">待人工复核</p>
  </article>
  return <section aria-label="AI 复查" className="flex flex-col gap-3">
    <h3 className="text-sm font-semibold">AI 复查</h3>
    <p className="text-sm">{audit?.status === "completed" ? "已完成" : collaboration.phase === "auditing" ? "复核未完成" : "等待主审完成"} · {audit?.checks.length ?? 0} / {result.findings.length} 条</p>
    {flagged.length > 0 && <p className="text-sm">{flagged.length} 条意见需人工核对。</p>}
    <p className="text-xs text-muted-foreground">机器意见不代表人工复核通过；主审原结果保留。</p>
    {flagged.length > 0 && <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">查看需核对意见（{flagged.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{flagged.map(check)}</CollapsibleContent>
    </Collapsible>}
    {(audit?.unreviewedRuleIds.length ?? 0) > 0 && <p className="break-words text-sm">尚未复核：{audit!.unreviewedRuleIds.join("、")}</p>}
    {clear.length > 0 && <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">查看保留意见（{clear.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{clear.map(check)}</CollapsibleContent>
    </Collapsible>}
    {(audit?.rejected.length ?? 0) > 0 && <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">未采用的复核意见（{audit!.rejected.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">{audit!.rejected.map((item, index) => <p className="break-words text-sm" key={index}>{item.ruleId}：{item.reason}</p>)}</CollapsibleContent>
    </Collapsible>}
  </section>
}

function CompletedReviewReport({ result }: { result: ReviewResult }) {
  const view = getReportView(result)
  const candidate = result.sceneCandidates?.find(item => item.id === result.sceneSelection?.sceneId)
  const sceneLabel = candidate?.label ?? (reviewSceneLabel(result.input.context.scene) || "合同审查")
  const clear = view.noIssueFindings
  const groups = [...view.groups].sort((a, b) => severityOrder(a.findings[0].severity) - severityOrder(b.findings[0].severity))
  const severityCounts = { 重大: 0, 一般: 0, 提示: 0 }
  for (const finding of groups.flatMap(group => group.findings)) {
    if (finding.severity === "重大关注") severityCounts.重大++
    else if (finding.severity === "一般关注") severityCounts.一般++
    else severityCounts.提示++
  }
  return <div className="flex flex-col gap-6">
    <header className="space-y-2">
      <h3 className="text-base font-semibold">合同审查报告</h3>
      <p className="text-sm text-muted-foreground">{sceneLabel} · 审查立场：{result.input.context.role ?? "未确认"}</p>
      <p className="text-sm font-medium">{view.summary}</p>
      <p className="text-sm">重大 {severityCounts.重大} 项 · 一般 {severityCounts.一般} 项 · 提示 {severityCounts.提示} 项</p>
      <p className="text-sm">{view.outcomeNotice}</p>
      {view.scopeNotes.map(note => <p role="note" className="text-sm" key={note}>{note}</p>)}
    </header>
    {(view.incomplete || view.auditNotice) && <div role="status" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{view.incomplete ? "阶段性结果" : "审查说明"}</p>
      {view.incomplete && <p>审查尚未全部完成，以下问题可能继续变化。</p>}
      {view.auditNotice && <p>{view.auditNotice}</p>}
    </div>}
    {groups.length > 0 && <section className="flex flex-col gap-4"><h3 className="text-sm font-semibold">审查发现</h3>
      <p className="text-xs text-muted-foreground">按风险从高到低展示；展开后可查看同类的其余问题。</p>
      {groups.map((group, index) => <section key={group.category} className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">{index + 1}. {CATEGORY_LABELS[group.category]}</h4>
        <FindingDetail finding={group.findings[0]} result={result} />
        {group.findings.length > 1 && <Collapsible>
          <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">查看本类其余 {group.findings.length - 1} 项问题<span className="sr-only">：{group.category}</span></Button></CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">{group.findings.slice(1).map(item => <FindingDetail key={item.ruleId} finding={item} result={result} />)}</CollapsibleContent>
        </Collapsible>}
      </section>)}
    </section>}
    <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">{view.incomplete ? "尚未完成的检查" : "检查记录"}</h3>
      {view.unfinishedGroups.map(item => <p className="text-sm" key={item.label}>{item.label}：还有 {item.count} 项检查未形成有效结论。</p>)}
      {result.errors.filter(item => !["REVIEW_AUDIT_INCOMPLETE", "REVIEW_PRIMARY_INCOMPLETE"].includes(item.code)).map((item, index) => <p role="alert" key={index} className="text-sm text-destructive">{item.message}</p>)}
      <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">展开检查进度与停止原因</Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          <p className="break-words text-xs text-muted-foreground">本报告基于所选成果版本的保存解析快照生成。</p>
          <SceneIdentification result={result} />
          {result.agent && <p className="text-sm">已读正文 {result.agent.readParagraphIndexes.length} / {result.paragraphs.length} 段</p>}
          <IndependentAudit result={result} />
          <Table><TableHeader><TableRow><TableHead>检查类别</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{result.coverage.map(item => <TableRow key={item.category}><TableCell className="whitespace-normal">{item.category}</TableCell><TableCell className="whitespace-normal">{item.status}：{item.note}</TableCell></TableRow>)}</TableBody></Table>
          {view.unfinished.map(item => <p className="break-words text-sm" key={item.ruleId}>{item.ruleId}：{item.detail}</p>)}
          {result.notLocated.length > 0 && <div className="space-y-2 text-sm"><p className="font-medium">未定位的检查项</p>{result.notLocated.map(item => <p className="break-words" key={item.ruleId}>{item.ruleId}：{item.reason === "no-match" ? "未执行" : "仅有目录，待核实"}；{item.detail}</p>)}<p>以上检查项不计为已通过。</p></div>}
          {result.errors.map((item, index) => <p className="break-words text-sm" key={index}>{item.code}：{item.message}</p>)}
          {result.warnings.map((item, index) => <p className="break-words text-sm text-muted-foreground" key={index}>{item}</p>)}
          {result.findings.some(item => item.pending.length) && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">原始待核实记录</Button></CollapsibleTrigger><CollapsibleContent className="space-y-2 pt-3">{result.findings.filter(item => item.pending.length).map(item => <p className="break-words text-sm" key={item.ruleId}>{item.ruleId}：{item.pending.join("；")}</p>)}</CollapsibleContent></Collapsible>}
          {result.rejected.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">未采用的回答（{result.rejected.length}）</Button></CollapsibleTrigger><CollapsibleContent className="space-y-2 pt-3">{result.rejected.map((item, index) => <p className="break-words text-sm" key={index}>{item.ruleId}：{item.reason} · {item.detail}</p>)}</CollapsibleContent></Collapsible>}
        </CollapsibleContent>
      </Collapsible>
    </section>
    {clear.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">查看无问题结论（{clear.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{clear.map(item => <FindingDetail key={item.ruleId} finding={item} result={result} />)}</CollapsibleContent>
    </Collapsible>}
    <div className="space-y-1" role="note">
      {result.mode === "debug" && <p className="text-xs text-muted-foreground">审查依据尚未签核，本报告仅供专业审核参考。</p>}
      <p className="text-xs text-muted-foreground">机器审查结论不代表合同无风险，仍需人工复核；引文真实不代表法律适用正确。</p>
    </div>
  </div>
}

/** Scene stops never fall back to an empty risk summary. */
export function ReviewReportView({ result }: { result: ReviewResult }) {
  if (result.sceneCandidates && result.sceneSelection?.status !== "matched") return <div className="flex flex-col gap-4">
    <SceneIdentification result={result} />
    {!result.sceneSelection && <p role="status" className="text-sm">{result.errors.length ? "场景识别未完成" : "正在识别场景"}</p>}
    {result.errors.map((item, index) => <p role="alert" key={index} className="text-sm text-destructive">{item.message}</p>)}
    <p role="note" className="text-xs text-muted-foreground">场景未确认，未生成风险结论；机器审查结论不代表合同无风险。</p>
  </div>
  return <CompletedReviewReport result={result} />
}
