"use client"

import { useState } from "react"
import { BookOpenIcon, FileTextIcon, PlusIcon, ScaleIcon } from "lucide-react"

import { DocumentEditor, type DocumentChange, type LocalDocument } from "@/components/document-editor"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function Workbench() {
  const [documents, setDocuments] = useState<LocalDocument[]>([])
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("documents")
  const activeDocument = documents.find((document) => document.id === activeDocumentId)

  function createDocument() {
    const document: LocalDocument = {
      id: crypto.randomUUID(),
      title: "未命名文档",
      content: "",
      prompt: "",
    }
    setDocuments((current) => [...current, document])
    setActiveDocumentId(document.id)
  }

  function updateDocument(change: DocumentChange) {
    setDocuments((current) => current.map((document) => (
      document.id === activeDocumentId ? { ...document, ...change } : document
    )))
  }

  if (activeDocument) {
    return <DocumentEditor key={activeDocument.id} document={activeDocument} onChange={updateDocument} onBack={() => setActiveDocumentId(null)} />
  }

  return (
    <main className="flex min-h-svh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ScaleIcon className="size-5" />
          衡鉴 <span className="font-normal text-muted-foreground">EquiLens</span>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 gap-6">
          <TabsList>
            <TabsTrigger value="documents"><FileTextIcon />文档</TabsTrigger>
            <TabsTrigger value="standards"><BookOpenIcon />规范库</TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-lg font-semibold">文档</h1>
              <Button onClick={createDocument}><PlusIcon />新建文档</Button>
            </div>
            {documents.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>暂无文档</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={createDocument}><PlusIcon />创建文档</Button>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>文档名称</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((document) => (
                      <TableRow key={document.id}>
                        <TableCell>
                          <Button variant="link" className="h-auto max-w-full justify-start px-0" onClick={() => setActiveDocumentId(document.id)}>
                            <FileTextIcon /><span className="truncate">{document.title.trim() || "未命名文档"}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
          <TabsContent value="standards" className="flex flex-col gap-6">
            <h1 className="text-lg font-semibold">规范库</h1>
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BookOpenIcon /></EmptyMedia>
                <EmptyTitle>暂无规范</EmptyTitle>
              </EmptyHeader>
            </Empty>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
