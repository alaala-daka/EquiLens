"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { compactText, groupIssues, isCompleteNoRisk } from "../../tools/contract-review/src/presentation"
import { toMarkdown } from "../../tools/contract-review/src/report"

function downloadReport(result: ReviewResult) {
  const blob = new Blob([toMarkdown(result)], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = (result.documentTitle.trim() || "合同审查").replace(/[\\/:*?"<>|]/g, "_") + "-审查报告.md"
  link.click()
  URL.revokeObjectURL(url)
}
function ExportReport({ result }: { result: ReviewResult }) {
  return <Button type="button" variant="outline" size="sm" onClick={() => downloadReport(result)}>导出报告（Markdown）</Button>
}

type Finding = ReviewResult["findings"][number]
function Citation({ result, index, quote }: { result: ReviewResult; index: number; quote: string }) {
  const paragraph = result.paragraphs.find(item => item.index === index)
  const offset = paragraph?.text.indexOf(quote) ?? -1
  return <AlertDialog>
    <AlertDialogTrigger asChild><Button type="button" variant="link" className="h-auto px-0">查看第 {index + 1} 段原文</Button></AlertDialogTrigger>
    <AlertDialogContent className="max-h-svh overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle>引用原文 · 第 {index + 1} 段</AlertDialogTitle>
        <AlertDialogDescription>保存版本：{result.input.documentVersionId ?? "未标注"}。解析快照：{result.input.parseSnapshotId ?? "未标注"}。</AlertDialogDescription>
      </AlertDialogHeader>
      {paragraph?.table && <p className="text-sm text-muted-foreground">表 {paragraph.table.index}，第 {paragraph.table.row} 行，第 {paragraph.table.column} 列</p>}
      {paragraph && offset >= 0 ? <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">
        {paragraph.text.slice(0, offset)}<mark>{paragraph.text.slice(offset, offset + quote.length)}</mark>{paragraph.text.slice(offset + quote.length)}
      </blockquote> : <p role="alert" className="text-sm text-destructive">引文与保存的解析快照不匹配。</p>}
      <AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
function FindingDetail({ finding, result, priority = false }: { finding: Finding; result: ReviewResult; priority?: boolean }) {
  const citations = finding.citations ?? (finding.quote ? [{ paragraphIndex: finding.paragraphIndex, quote: finding.quote }] : [])
  return <article className="flex flex-col gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.severity}</Badge>{priority && <span className="text-sm font-medium">优先关注</span>}</div>
    <p className="break-words text-sm font-medium">{finding.kind === "未发现问题" ? "结论" : "问题"}：{compactText(finding.risk, 80)}</p>
    <p className="break-words text-sm">建议：{compactText(finding.suggestion, 120)}</p>
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm" className="w-fit">原文与详情<span className="sr-only">：{finding.category} · {finding.ruleId}</span></Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        <p className="whitespace-pre-wrap break-words text-sm">完整结论：{finding.risk}</p>
        {finding.quote && <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">{finding.quote}</blockquote>}
        {citations.map((citation, index) => <div key={index}><Citation result={result} index={citation.paragraphIndex} quote={citation.quote} /></div>)}
        {finding.kind === "缺失条款" && <p className="text-sm text-muted-foreground">已检查 {finding.checkedParagraphIndexes?.length ?? 0} 段正文。</p>}
        {finding.impact && <p className="break-words text-sm">影响：{finding.impact}</p>}
        <p className="whitespace-pre-wrap break-words text-sm">完整建议：{finding.suggestion}</p>
        {finding.sourceReferences?.length ? <ul className="space-y-2 text-sm text-muted-foreground">{finding.sourceReferences.map(source => <li key={source.sourceId}>
          {source.type}：{source.name} {source.article} {source.version}
          {source.officialUrl?.startsWith("https://") && <> · <a className="underline" href={source.officialUrl} target="_blank" rel="noreferrer">来源</a></>}
        </li>)}</ul> : finding.basis.length > 0 ? <p className="break-words text-sm text-muted-foreground">依据：{finding.basis.join("、")}</p> : null}
        <p className="text-xs text-muted-foreground">{finding.reviewStatus}</p>
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
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="break-words text-sm">{selection.reason}</p>
    {selection.missingInfo.length > 0 && <ul className="list-disc space-y-1 pl-4 text-sm">{selection.missingInfo.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">识别依据</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{selection.evidence.map((item, index) => <div key={index} className="space-y-2">
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
  return <section aria-label="独立复核" className="flex flex-col gap-3">
    <h3 className="text-sm font-semibold">独立复核</h3>
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
export function ContractReviewReport({ result }: { result: ReviewResult }) {
  if (result.sceneCandidates && result.sceneSelection?.status !== "matched") return <div className="flex flex-col gap-4">
    <SceneIdentification result={result} />
    {!result.sceneSelection && <p role="status" className="text-sm">{result.errors.length ? "场景识别未完成" : "正在识别场景"}</p>}
    {result.errors.map((item, index) => <p role="alert" key={index} className="text-sm text-destructive">{item.message}</p>)}
    <div className="flex justify-end"><ExportReport result={result} /></div>
  </div>
  return <CompletedReviewReport result={result} />
}
function CompletedReviewReport({ result }: { result: ReviewResult }) {
  const groups = groupIssues(result.findings)
  const issueCount = groups.reduce((count, group) => count + group.findings.length, 0)
  const pending = result.findings.filter(item => item.kind === "待核实")
  const questions = result.findings.filter(item => item.kind !== "待核实" && item.pending.length > 0)
  const clear = result.findings.filter(item => item.kind === "未发现问题")
  return <div className="flex flex-col gap-6">
    <SceneIdentification result={result} />
    <IndependentAudit result={result} />
    {result.mode === "debug" && <p role="note" className="rounded-lg border p-3 text-sm">依据尚未核对，本报告仅供联调，不能作为正式法律结论。</p>}
    {!result.input.complete && <p role="note" className="text-sm">解析范围不完整，不能确认完整无风险或条款缺失。</p>}
    <div className="flex flex-col gap-2"><h3 className="text-sm font-semibold">风险摘要</h3>
      <p className="text-sm">{issueCount} 项问题，{pending.length + questions.length} 项待核实。</p>
      {result.agent && <p className="text-sm text-muted-foreground">已读正文 {result.agent.readParagraphIndexes.length} / {result.paragraphs.length} 段</p>}
      <p className="text-xs text-muted-foreground">AI 辅助审查，结论均待人工复核。引文真实不代表法律适用正确。</p>
    </div>
    {result.coverage.filter(item => item.status === "未覆盖" || item.status === "待核实").map(item =>
      <p key={item.category} className="break-words text-sm">{item.category} · {item.status}：{item.note}</p>)}
    <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">检查覆盖（{result.coverage.length} 类）</Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-3"><Table><TableHeader><TableRow><TableHead>检查类别</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
      <TableBody>{result.coverage.map(item => <TableRow key={item.category}><TableCell className="whitespace-normal">{item.category}</TableCell><TableCell className="whitespace-normal">{item.status}</TableCell></TableRow>)}</TableBody>
    </Table></CollapsibleContent></Collapsible>
    <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">问题与修改建议</h3>
      {groups.map(group => <section key={group.category} className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">{group.category}（{group.findings.length} 项）</h4>
        <FindingDetail finding={group.findings[0]} result={result} priority />
        {group.findings.length > 1 && <Collapsible>
          <CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">其余 {group.findings.length - 1} 项问题<span className="sr-only">：{group.category}</span></Button></CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">{group.findings.slice(1).map(item => <FindingDetail key={item.ruleId} finding={item} result={result} />)}</CollapsibleContent>
        </Collapsible>}
      </section>)}
      {!issueCount && <p className="text-sm text-muted-foreground">{isCompleteNoRisk(result) ? "声明范围内未发现问题，仍需人工复核。" : "尚未形成完整的无风险结论，请查看待核实和未完成项。"}</p>}
    </section>
    {pending.length + questions.length > 0 && <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">待核实</h3>
      {[...pending, ...questions].map(item => <div key={item.ruleId} className="rounded-lg border p-3 text-sm"><p className="font-medium">{item.category} · {item.ruleId}</p><p className="whitespace-pre-wrap break-words">{item.pending.join("；") || item.risk}</p></div>)}
    </section>}
    {result.notLocated.map(item => <p key={item.ruleId} className="text-sm">未完成检查：{item.ruleId} · {item.detail}</p>)}
    {result.errors.map((item, index) => <p role="alert" key={index} className="text-sm text-destructive">{item.message}</p>)}
    {result.warnings.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">检查范围与提示</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">{result.warnings.map((item, index) => <p className="break-words text-sm text-muted-foreground" key={index}>{item}</p>)}</CollapsibleContent>
    </Collapsible>}
    {clear.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">查看无问题结论（{clear.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">{clear.map(item => <FindingDetail key={item.ruleId} finding={item} result={result} />)}</CollapsibleContent>
    </Collapsible>}
    {result.rejected.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline">未采用的回答（{result.rejected.length}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">{result.rejected.map((item, index) => <p className="break-words text-sm" key={index}>{item.ruleId}：{item.reason} · {item.detail}</p>)}</CollapsibleContent>
    </Collapsible>}
    <div className="flex justify-end"><ExportReport result={result} /></div>
  </div>
}
