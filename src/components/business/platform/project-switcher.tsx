"use client"

import { useState, type FormEvent } from "react"
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, PlusIcon } from "lucide-react"
import type { ProjectRole } from "@/lib/business/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { useProjectHost } from "./project-host"
import { ProjectsClientError, type ProjectCreatePayload, type ProjectSource } from "./projects-client"

const roleLabel: Record<ProjectRole, string> = {
  admin: "项目管理员",
  editor: "可编辑成员",
  viewer: "只读成员",
}

const emptyForm = {
  name: "",
  source: "synthetic" as ProjectSource,
  sourceReference: "",
  purpose: "",
  retentionUntil: "",
}

/**
 * Current-project switcher for the workbench header. The server list is the
 * only source of projects, so unreadable projects never appear here.
 */
export function ProjectSwitcher() {
  const host = useProjectHost()
  const [creating, setCreating] = useState(false)

  if (host.status === "loading") return <span role="status" className="sr-only">正在读取项目</span>
  if (host.status === "anonymous") return null
  if (host.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <span role="alert" className="text-sm text-muted-foreground">{host.error || "项目列表暂不可用，请重试。"}</span>
        <Button variant="outline" size="sm" onClick={() => void host.refresh()}>重试</Button>
      </div>
    )
  }

  if (host.projects.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">暂无项目</span>
        {host.canCreateProject && <Button variant="outline" size="sm" onClick={() => setCreating(true)}><PlusIcon />新建项目</Button>}
        <ProjectCreateSheet open={creating} onOpenChange={setCreating} onCreate={host.createProject} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={host.switching} aria-busy={host.switching} aria-label={host.currentProject ? `切换项目，当前项目：${host.currentProject.name}` : "选择项目"}>
            <FolderOpenIcon />
            <span className="max-w-40 truncate">{host.currentProject?.name ?? "选择项目"}</span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel>项目</DropdownMenuLabel>
          {host.projects.map(project => (
            <DropdownMenuItem key={project.id} onSelect={() => void host.selectProject(project.id)}>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {project.id === host.currentProject?.id ? <CheckIcon /> : null}
              </span>
              <span className="truncate">{project.name}</span>
              <span className="ml-auto pl-3 text-xs text-muted-foreground">{roleLabel[project.role]}</span>
            </DropdownMenuItem>
          ))}
          {host.canCreateProject && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}><PlusIcon />新建项目</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {host.currentProject && <Badge variant="secondary">{roleLabel[host.currentProject.role]}</Badge>}
      {host.switchError && (
        <span role="alert" className="max-w-64 truncate text-sm text-destructive" title={host.switchError}>
          {host.switchError}{host.switchFailures.length > 0 ? `（${host.switchFailures.map(failure => failure.label).join("、")}）` : ""}
        </span>
      )}
      <ProjectCreateSheet open={creating} onOpenChange={setCreating} onCreate={host.createProject} />
    </div>
  )
}

function ProjectCreateSheet({ open, onOpenChange, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: ProjectCreatePayload) => Promise<unknown>
}) {
  const [form, setForm] = useState(emptyForm)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const update = (next: Partial<typeof emptyForm>) => setForm(current => ({ ...current, ...next }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError("")
    try {
      await onCreate(form)
      setForm(emptyForm)
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof ProjectsClientError ? failure.message : "创建项目失败，请重试。")
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={next => {
      if (pending) return
      if (!next) { setForm(emptyForm); setError("") }
      onOpenChange(next)
    }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>新建项目</SheetTitle>
          <SheetDescription>登记资料处理授权与保留期限。</SheetDescription>
        </SheetHeader>
        <form id="project-create-form" className="flex flex-1 flex-col gap-6 overflow-y-auto px-4" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">项目名称</FieldLabel>
              <Input id="project-name" value={form.name} maxLength={120} required autoComplete="off" onChange={event => update({ name: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-source">资料性质</FieldLabel>
              <NativeSelect id="project-source" value={form.source} onChange={event => update({ source: event.target.value as ProjectSource })}>
                <NativeSelectOption value="synthetic">合成资料</NativeSelectOption>
                <NativeSelectOption value="authorized">已授权资料</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-source-reference">来源依据</FieldLabel>
              <Input id="project-source-reference" value={form.sourceReference} maxLength={500} required autoComplete="off" onChange={event => update({ sourceReference: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-purpose">处理目的</FieldLabel>
              <Input id="project-purpose" value={form.purpose} maxLength={500} required autoComplete="off" onChange={event => update({ purpose: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-retention">保留截止日期</FieldLabel>
              <Input id="project-retention" type="date" value={form.retentionUntil} required onChange={event => update({ retentionUntil: event.target.value })} />
            </Field>
          </FieldGroup>
          <FieldError aria-live="polite">{error}</FieldError>
        </form>
        <SheetFooter>
          <Button type="submit" form="project-create-form" disabled={pending} aria-busy={pending}>{pending ? "正在创建" : "创建项目"}</Button>
          <SheetClose asChild><Button variant="outline" disabled={pending}>取消</Button></SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
