"use client"

import { ArrowLeftIcon, ArrowUpIcon, BotIcon, FileTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"

export type LocalDocument = {
  id: string
  title: string
  content: string
  prompt: string
}

export type DocumentChange = Partial<Omit<LocalDocument, "id">>

export function DocumentEditor({
  document,
  onChange,
  onBack,
}: {
  document: LocalDocument
  onChange: (change: DocumentChange) => void
  onBack: () => void
}) {
  const isMobile = useIsMobile()

  return (
    <main className="flex h-svh flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          文档
        </Button>
        <Separator orientation="vertical" className="data-vertical:h-4" />
        <Input
          aria-label="文档标题"
          className="min-w-0 flex-1 md:max-w-sm"
          value={document.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="未命名文档"
        />
      </header>
      <ResizablePanelGroup key={isMobile ? "mobile" : "desktop"} orientation={isMobile ? "vertical" : "horizontal"} className="min-h-0 flex-1">
        <ResizablePanel id="editor" defaultSize={isMobile ? "55%" : "70%"} minSize="35%">
          <section aria-label="文档编辑器" className="flex h-full flex-col">
            <h1 className="sr-only">文档编辑器</h1>
            <Textarea
              aria-label="文档正文"
              placeholder="输入正文…"
              value={document.content}
              onChange={(event) => onChange({ content: event.target.value })}
              className="min-h-0 flex-1 resize-none rounded-none border-0 p-6 text-base leading-8 shadow-none focus-visible:ring-inset md:p-8"
            />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="调整编辑器与会话区域大小" />
        <ResizablePanel id="agent" defaultSize={isMobile ? "45%" : "30%"} minSize="25%">
          <aside aria-label="Agent 会话" className="flex h-full flex-col">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-medium"><BotIcon className="size-4" />Agent</h2>
            </header>
            <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
              <FileTextIcon className="size-3.5 shrink-0" />
              <span className="truncate">{document.title.trim() || "未命名文档"}</span>
            </div>
            <div className="flex min-h-0 flex-1 overflow-auto">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
                  <EmptyTitle>暂无会话</EmptyTitle>
                </EmptyHeader>
              </Empty>
            </div>
            <div className="p-4">
              <InputGroup>
                <InputGroupTextarea
                  aria-label="Agent 消息"
                  placeholder="输入消息…"
                  value={document.prompt}
                  onChange={(event) => onChange({ prompt: event.target.value })}
                />
                <InputGroupAddon align="block-end">
                  <InputGroupButton type="button" size="icon-sm" variant="default" className="ml-auto" disabled aria-label="发送消息">
                    <ArrowUpIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  )
}
