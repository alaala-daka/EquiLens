"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { ReviewResult } from "@/lib/contract-reviews/types"
import { documentTaskLabels, type Citation } from "@/lib/document-agent/types"
import { documentAnalysisMarkdown, formatFen } from "@/lib/document-agent/report"
import { useEffect, useRef, useState } from "react"
import { downloadCollectionLetter } from "@/lib/contract-reviews/client"
import { DocumentSessionError } from "@/lib/documents/client"

function Sources({ sources }: { sources: Citation[] }) {
  if (!sources.length) return null
  return <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="link" size="sm" className="px-0">查看原文</Button></CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 text-sm text-muted-foreground">{sources.map((source, index) => <blockquote key={index} className="border-l-2 pl-3">第 {source.paragraphIndex + 1} 段：{source.quote}</blockquote>)}</CollapsibleContent>
  </Collapsible>
}
export function DocumentAgentReport({ result, taskId, onSessionUnavailable }: { result: ReviewResult; taskId?: string; onSessionUnavailable?: (failure: DocumentSessionError) => void }) {
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState("")
  const download = useRef<AbortController | null>(null)
  useEffect(() => () => { download.current?.abort(); download.current = null }, [taskId])
  const analysis = result.documentAnalysis!, data = analysis.extraction
  const usable = (id: string) => !analysis.rejected.some(item => item.id === id)
  const checked = (id: string) => analysis.audit.checks.some(item => item.id === id && item.accepted)
  const exportReport = () => {
    const url = URL.createObjectURL(new Blob([documentAnalysisMarkdown(analysis, result.documentTitle, result.input.documentVersionId, result.input.parseSnapshotId)], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a"); link.href = url; link.download = (result.documentTitle || "文档").replace(/[\\/:*?"<>|]/g, "_") + "-" + documentTaskLabels[analysis.task] + ".md"; link.click(); URL.revokeObjectURL(url)
  }
  const gaps = [...new Set([...(data?.gaps ?? []), ...analysis.audit.gaps, ...analysis.calculationNotes])]
  const notes = [...new Set([...(data?.notes ?? []), ...(analysis.audit.notes ?? [])])]
  const downloadLetter = async () => {
    if (!taskId || download.current || !analysis.letter?.export) return
    const controller = new AbortController(); download.current = controller; setDownloading(true); setDownloadError("")
    try {
      const blob = await downloadCollectionLetter(taskId, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = analysis.letter.export.filename; link.click(); URL.revokeObjectURL(url)
    } catch (failure) { if (!controller.signal.aborted) { setDownloadError(failure instanceof Error ? failure.message : "下载失败，请重试。"); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
    finally { if (download.current === controller) { download.current = null; setDownloading(false) } }
  }
  return <section aria-label={documentTaskLabels[analysis.task] + "结果"} className="space-y-5">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{documentTaskLabels[analysis.task]}</h3><Badge variant="outline">待人工复核</Badge></div>
    <p className="text-sm text-muted-foreground">核对截至 {analysis.cutoff}</p>
    {data && checked("overview") && <p className="text-sm">{data.overview}</p>}
    {analysis.letter && <div className="space-y-3 rounded-lg border p-4"><h4 className="text-base font-medium">{analysis.letter.title}</h4>{analysis.letter.paragraphs.map((line, index) => <p key={index} className="whitespace-pre-wrap text-sm">{line}</p>)}</div>}
    {analysis.calculation && <div className="space-y-2 rounded-lg border p-4"><p className="text-sm">有条件测算余额</p><p className="text-xl font-semibold">{formatFen(analysis.calculation.unpaidFen)}</p><p className="text-sm text-muted-foreground">{analysis.calculation.formula}</p></div>}
    {data && data.amounts.some((_, index) => usable("amount:" + index)) && <div className="space-y-2"><h4 className="text-sm font-medium">材料记载金额</h4><Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead>金额</TableHead></TableRow></TableHeader><TableBody>
      {data.amounts.map((item, index) => usable("amount:" + index) && <TableRow key={index}><TableCell className="whitespace-normal"><p>{item.label} · {item.kind}</p>{!checked("amount:" + index) && <Badge variant="outline">需核对</Badge>}<Sources sources={[item.source]} /></TableCell><TableCell className="whitespace-normal">{item.amountYuan} 元</TableCell></TableRow>)}
    </TableBody></Table></div>}
    {data?.terms.map((item, index) => usable("term:" + index) && <div key={index} className="space-y-1"><h4 className="text-sm font-medium">{item.title}</h4><p className="text-sm">{item.detail}</p><Sources sources={item.sources} /></div>)}
    {data && data.events.length > 0 && <div className="space-y-3"><h4 className="text-sm font-medium">证据时间线</h4>{data.events.map((item, index) => ({ item, index })).filter(({ index }) => usable("event:" + index)).sort((a, b) => (a.item.date ?? "9999").localeCompare(b.item.date ?? "9999")).map(({ item, index }) => <div key={index} className="space-y-1 border-l-2 pl-3"><p className="text-xs text-muted-foreground">{item.date ?? "日期未明"} · {item.nature}</p><p className="text-sm font-medium">{item.title}</p><p className="text-sm">{item.detail}</p>{item.support !== "材料支持" && <Badge variant="outline">{item.support}</Badge>}{!checked("event:" + index) && <Badge variant="outline">需核对</Badge>}<Sources sources={[...item.sources, ...item.conflicts]} /></div>)}</div>}
    {data?.disputes.map((item, index) => usable("dispute:" + index) && <div key={index} className="space-y-1"><h4 className="text-sm font-medium">争点：{item.title}</h4><p className="text-sm">{item.detail}</p></div>)}
    {gaps.length > 0 && <div className="space-y-2"><h4 className="text-sm font-medium">需要补充或核对</h4><ul className="list-disc space-y-1 pl-5 text-sm">{gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div>}
    {!analysis.audit.complete && <p role="status" className="text-sm">独立核对尚未完成，已有结果保留。</p>}
    {notes.length > 0 && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="link" size="sm" className="px-0">查看范围提示</Button></CollapsibleTrigger><CollapsibleContent className="space-y-2 text-sm text-muted-foreground">{notes.map(note => <p key={note}>{note}</p>)}</CollapsibleContent></Collapsible>}
    {(analysis.rejected.length > 0 || analysis.audit.checks.some(item => !item.accepted)) && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline" size="sm">查看未采用或存疑内容</Button></CollapsibleTrigger><CollapsibleContent className="space-y-2 pt-3 text-sm">{analysis.rejected.map(item => <p key={item.id}>{item.reason}</p>)}{analysis.audit.checks.filter(item => !item.accepted).map(item => <p key={item.id}>{item.reason}</p>)}</CollapsibleContent></Collapsible>}
    {result.errors.map(error => <p role="alert" key={error.code} className="text-sm text-destructive">{error.message}</p>)}
    {data && <Button type="button" variant="outline" size="sm" onClick={exportReport}>导出报告（Markdown）</Button>}
    {taskId && analysis.letter?.export && <Button type="button" variant="outline" size="sm" disabled={downloading} onClick={() => void downloadLetter()}>下载催款函草稿（Word）</Button>}
    {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
  </section>
}
