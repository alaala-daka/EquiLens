"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ReviewResult } from "@/lib/contract-reviews/types"

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
function FindingDetail({ finding, result }: { finding: Finding; result: ReviewResult }) {
  const citations = finding.citations ?? (finding.quote ? [{ paragraphIndex: finding.paragraphIndex, quote: finding.quote }] : [])
  return <article className="flex flex-col gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.severity}</Badge><span className="text-sm font-medium">{finding.category}</span></div>
    <p className="break-words text-sm font-medium">{finding.risk}</p>
    {finding.quote && <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-4 text-sm">{finding.quote}</blockquote>}
    {citations.map((citation, index) => <div key={index}><Citation result={result} index={citation.paragraphIndex} quote={citation.quote} /></div>)}
    {finding.kind === "缺失条款" && <p className="text-sm text-muted-foreground">已检查 {finding.checkedParagraphIndexes?.length ?? 0} 段正文。</p>}
    {finding.impact && <p className="break-words text-sm">影响：{finding.impact}</p>}
    <p className="whitespace-pre-wrap break-words text-sm">建议：{finding.suggestion}</p>
    {finding.sourceReferences?.length ? <ul className="space-y-2 text-sm text-muted-foreground">{finding.sourceReferences.map(source => <li key={source.sourceId}>
      {source.type}：{source.name} {source.article} {source.version}
      {source.officialUrl?.startsWith("https://") && <> · <a className="underline" href={source.officialUrl} target="_blank" rel="noreferrer">来源</a></>}
    </li>)}</ul> : finding.basis.length > 0 ? <p className="break-words text-sm text-muted-foreground">依据：{finding.basis.join("、")}</p> : null}
    <p className="text-xs text-muted-foreground">{finding.reviewStatus}</p>
  </article>
}
export function ContractReviewReport({ result }: { result: ReviewResult }) {
  const issues = result.findings.filter(item => ["发现问题", "缺失条款"].includes(item.kind))
  const pending = result.findings.filter(item => item.kind === "待核实")
  const clear = result.findings.filter(item => item.kind === "未发现问题")
  return <div className="flex flex-col gap-6">
    {result.mode === "debug" && <p role="note" className="rounded-lg border p-3 text-sm">依据尚未核对，本报告仅供联调，不能作为正式法律结论。</p>}
    <div className="flex flex-col gap-2"><h3 className="text-sm font-semibold">风险摘要</h3>
      <p className="text-sm">{issues.length} 项问题，{pending.length} 项待核实。</p>
      {result.agent && <p className="text-sm text-muted-foreground">已读正文 {result.agent.readParagraphIndexes.length} / {result.paragraphs.length} 段</p>}
      <p className="text-xs text-muted-foreground">AI 辅助审查，结论均待人工复核。引文真实不代表法律适用正确。</p>
    </div>
    <Table><TableHeader><TableRow><TableHead>检查类别</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
      <TableBody>{result.coverage.map(item => <TableRow key={item.category}><TableCell className="whitespace-normal">{item.category}</TableCell><TableCell className="whitespace-normal">{item.status}</TableCell></TableRow>)}</TableBody>
    </Table>
    <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">问题与修改建议</h3>
      {issues.map(item => <FindingDetail key={item.ruleId} finding={item} result={result} />)}
      {!issues.length && <p className="text-sm text-muted-foreground">{result.status === "success" ? "声明范围内未发现问题，仍需人工复核。" : "尚未形成完整的无风险结论，请查看待核实和未完成项。"}</p>}
    </section>
    {pending.length > 0 && <section className="flex flex-col gap-3"><h3 className="text-sm font-semibold">待核实</h3>
      {pending.map(item => <div key={item.ruleId} className="rounded-lg border p-3 text-sm"><p className="font-medium">{item.category}</p><p className="whitespace-pre-wrap break-words">{item.pending.join("；") || item.risk}</p></div>)}
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
  </div>
}
