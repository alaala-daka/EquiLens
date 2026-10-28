"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listReviewTasks } from "@/lib/contract-reviews/client"
import { taskDisplayState, type ReviewTask } from "@/lib/contract-reviews/types"
import { errorMessage } from "@/lib/documents/types"
import { DocumentSessionError } from "@/lib/documents/client"
import { documentTaskLabels } from "@/lib/document-agent/types"

export function ContractReviewHistory({ onOpen, busy, onSessionUnavailable }: { onOpen: (documentId: string, taskId: string) => void; busy: boolean; onSessionUnavailable?: (failure: DocumentSessionError) => void }) {
  const [tasks, setTasks] = useState<ReviewTask[]>([])
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try { const value = await listReviewTasks(undefined, controller.signal); if (!disposed) { setTasks(value.tasks); setError("") } }
      catch (failure) { if (!disposed && !controller.signal.aborted) { setError(errorMessage(failure)); if (failure instanceof DocumentSessionError) onSessionUnavailable?.(failure) } }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 5000) }
    }
    void refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [reload, onSessionUnavailable])
  if (!tasks.length && !error) return null
  return <section aria-label="处理记录" className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">处理记录</h2>
    {error && <div className="flex items-center gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>重试</Button></div>}
    {tasks.length > 0 && <Table><TableHeader><TableRow><TableHead>文档</TableHead><TableHead>状态</TableHead><TableHead>提交时间</TableHead></TableRow></TableHeader><TableBody>
      {tasks.map(task => <TableRow key={task.id}><TableCell className="whitespace-normal"><Button type="button" variant="link" className="h-auto whitespace-normal px-0 text-left" disabled={busy} onClick={() => onOpen(task.documentId, task.id)}>{task.title}</Button><p className="text-xs text-muted-foreground">{documentTaskLabels[task.kind ?? "contract-review"]}</p></TableCell><TableCell>{taskDisplayState(task)}</TableCell><TableCell className="whitespace-normal">{new Date(task.createdAt).toLocaleString("zh-CN")}</TableCell></TableRow>)}
    </TableBody></Table>}
  </section>
}
