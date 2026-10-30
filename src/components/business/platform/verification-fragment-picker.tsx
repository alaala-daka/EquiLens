"use client"

import { useState } from "react"
import { FileSearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { SnapshotFragment } from "@/lib/business/materials-client"
import { filterFragments, fragmentLocationLabel, fragmentPreview } from "./verification-state"

/**
 * Snapshot fragment picker for manual requirements and certificate fields.
 * The picked fragment is the only source a manual requirement/field may cite;
 * the server re-reads it and checks the quote verbatim before saving.
 */
export function VerificationFragmentPicker({ open, onOpenChange, title, fragments, loading, error, onSelect }: {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  fragments: readonly SnapshotFragment[]
  loading: boolean
  error: string
  onSelect(fragment: SnapshotFragment): void
}) {
  const [query, setQuery] = useState("")
  const visible = filterFragments(fragments, query)
  return <Sheet open={open} onOpenChange={next => { if (!next) setQuery(""); onOpenChange(next) }}>
    <SheetContent className="flex flex-col overflow-hidden">
      <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>选择材料解析快照片段作为原文来源。</SheetDescription></SheetHeader>
      <div className="px-4"><Input type="search" aria-label="搜索原文片段" placeholder="搜索原文片段" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">正在读取解析快照</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!loading && !error && visible.length === 0 && <Empty className="border"><EmptyHeader><EmptyMedia variant="icon"><FileSearchIcon /></EmptyMedia><EmptyTitle>{query ? "未找到匹配片段" : "暂无解析片段"}</EmptyTitle></EmptyHeader></Empty>}
        {visible.map(fragment => <article key={fragment.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{fragmentLocationLabel(fragment)}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{fragmentPreview(fragment, 240)}</p>
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => { onSelect(fragment); onOpenChange(false) }}>选择该片段</Button>
        </article>)}
      </div>
    </SheetContent>
  </Sheet>
}
