"use client"

import { FileTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { documentSourceLabel, formatDocumentUpdatedAt } from "@/lib/documents/list-view"
import type { DocumentRecord } from "@/lib/documents/types"

type DocumentListProps = {
  documents: readonly DocumentRecord[]
  busy: boolean
  onOpen?: (id: string) => void
  onDownload?: (id: string) => void
}

export function DocumentList({ documents, busy, onOpen, onDownload }: DocumentListProps) {
  return (
    <div className="rounded-lg border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>文档名称</TableHead>
            <TableHead className="hidden md:table-cell">创建方式</TableHead>
            <TableHead className="hidden md:table-cell">更新时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map(document => (
            <TableRow key={document.id}>
              <TableCell className="whitespace-normal">
                {onOpen ? <Button variant="link" disabled={busy} className="h-auto max-w-full justify-start whitespace-normal px-0 text-left" onClick={() => onOpen(document.id)}>
                  <FileTextIcon className="shrink-0" />
                  <span className="min-w-0 break-words">{document.title.trim() || "未命名文档"}</span>
                </Button> : <span className="break-words">{document.title.trim() || "未命名文档"}</span>}
                {onDownload && <Button variant="link" disabled={busy} onClick={() => onDownload(document.id)} aria-label={`下载 Word：${document.title.trim() || "未命名文档"}`}>下载 Word</Button>}
                <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground md:hidden">
                  <span>{documentSourceLabel[document.source]}</span>
                  <span>{formatDocumentUpdatedAt(document.updatedAt)}</span>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell">{documentSourceLabel[document.source]}</TableCell>
              <TableCell className="hidden whitespace-normal md:table-cell">{formatDocumentUpdatedAt(document.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
