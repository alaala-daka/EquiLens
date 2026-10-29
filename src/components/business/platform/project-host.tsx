"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { UnsavedFailure, UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import { createProjectsClient, ProjectsClientError, type ProjectCreatePayload, type ProjectSummary } from "./projects-client"
import { createRequestGate } from "./request-gate"
import { retainProject } from "./project-retention"

export type ProjectHostStatus = "loading" | "anonymous" | "ready" | "error"

export type ProjectHostValue = {
  status: ProjectHostStatus
  projects: ProjectSummary[]
  currentProject: ProjectSummary | null
  canCreateProject: boolean
  error: string
  /** Bumped whenever the current project changes or access becomes unusable. */
  generation: number
  switching: boolean
  /** Unsaved workspace objects that blocked a project switch. */
  switchFailures: readonly UnsavedFailure[]
  switchError: string
  refresh(): Promise<void>
  selectProject(projectId: string): Promise<boolean>
  createProject(input: ProjectCreatePayload): Promise<ProjectSummary>
}

const storageKey = "equilens.project"
const client = createProjectsClient()
const ProjectHostContext = createContext<ProjectHostValue | null>(null)

function storedProjectId(): string | null {
  try {
    return window.localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

function storeProjectId(projectId: string) {
  try {
    window.localStorage.setItem(storageKey, projectId)
  } catch {
    // A blocked storage must not break project access.
  }
}

function clearStoredProjectId() {
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // A blocked storage must not break project access.
  }
}

/**
 * Workbench project host (C1). It only lists projects the server returned for
 * the current session and reauthorizes every explicit switch. Anonymous
 * sessions stay anonymous and keep the existing document workspace untouched.
 * Switching first saves the A2 workspace registry so project views cannot leak
 * unsaved edits across projects.
 */
export function ProjectHostProvider({ children, registry }: { children: ReactNode; registry?: UnsavedRegistry }) {
  const [status, setStatus] = useState<ProjectHostStatus>("loading")
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [canCreateProject, setCanCreateProject] = useState(false)
  const [error, setError] = useState("")
  const [generation, setGeneration] = useState(0)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState("")
  const [switchFailures, setSwitchFailures] = useState<readonly UnsavedFailure[]>([])
  // List refresh and switch reauthorization are independent single-flight gates:
  // a focus refresh must not abort a switch (and vice versa), or switching could
  // stay disabled forever when a stale finally sees a newer ticket.
  const [listGate] = useState(createRequestGate)
  const [switchGate] = useState(createRequestGate)
  const currentId = useRef<string | null>(null)
  const projectsRef = useRef<ProjectSummary[]>([])
  useEffect(() => {
    currentId.current = currentProjectId
    projectsRef.current = projects
  }, [currentProjectId, projects])

  const adopt = useCallback((projectId: string) => {
    const previous = currentId.current
    currentId.current = projectId
    setCurrentProjectId(projectId)
    storeProjectId(projectId)
    if (previous !== projectId) setGeneration(value => value + 1)
  }, [])

  const forget = useCallback(() => {
    if (currentId.current) return // Preserve mounted human edits on access failure.
    clearStoredProjectId()
    currentId.current = null
    projectsRef.current = []
    setCurrentProjectId(null)
    setProjects([])
    setCanCreateProject(false)
    setGeneration(value => value + 1)
  }, [])

  const reconcile = useCallback((list: ProjectSummary[], preferredId: string | null) => {
    const wanted = preferredId ?? currentId.current ?? storedProjectId()
    const retained = retainProject(projectsRef.current.find(project => project.id === currentId.current) ?? null, list)
    if (currentId.current && !preferredId && retained.blocked) {
      setStatus("error")
      setError("该项目已无访问权限。")
      return
    }
    const next = list.find(project => project.id === wanted) ?? list[0] ?? null
    projectsRef.current = list
    setProjects(list)
    if (!next) {
      clearStoredProjectId()
      currentId.current = null
      setCurrentProjectId(null)
      setGeneration(value => value + 1)
      return
    }
    adopt(next.id)
  }, [adopt])

  const load = useCallback(async () => {
    const request = listGate.begin()
    try {
      const data = await client.list(request.signal)
      if (request.signal.aborted || !listGate.isCurrent(request.ticket)) return
      setStatus("ready")
      setCanCreateProject(data.canCreateProject)
      setError("")
      reconcile(data.projects, null)
    } catch (failure) {
      if (request.signal.aborted || !listGate.isCurrent(request.ticket)) return
      if (failure instanceof ProjectsClientError && failure.status === 401) {
        forget()
        setStatus("anonymous")
        setError("")
        return
      }
      forget()
      setStatus("error")
      setError(failure instanceof ProjectsClientError ? failure.message : "项目列表暂不可用，请重试。")
    } finally {
      listGate.finish(request.ticket)
    }
  }, [forget, listGate, reconcile])

  useEffect(() => {
    let active = true
    const start = () => { if (active) void load() }
    // Defer the first request so the effect body never calls setState synchronously.
    queueMicrotask(start)
    const refresh = () => {
      if (document.visibilityState === "visible") void load()
    }
    window.addEventListener("focus", refresh)
    return () => {
      active = false
      listGate.cancel()
      switchGate.cancel()
      window.removeEventListener("focus", refresh)
    }
  }, [listGate, load, switchGate])

  const selectProject = useCallback(async (projectId: string): Promise<boolean> => {
    if (currentId.current === projectId) return true
    if (!projectsRef.current.some(project => project.id === projectId)) return false
    setSwitchError("")
    setSwitchFailures([])
    if (registry) {
      const saved = await registry.saveAll()
      if (!saved.ok) {
        setSwitchFailures(saved.failures)
        setSwitchError("存在未保存的修改，切换项目已取消。")
        return false
      }
    }
    // Cancel only an in-flight list refresh; the switch owns a separate gate so
    // focus refreshes cannot abort it or invalidate its request ticket.
    listGate.cancel()
    const request = switchGate.begin()
    setSwitching(true)
    try {
      const current = await client.get(projectId, request.signal)
      if (request.signal.aborted || !switchGate.isCurrent(request.ticket)) return false
      // The switch result is authoritative; drop any list refresh that started
      // while the switch was in flight so a stale list cannot adopt another project.
      listGate.cancel()
      setStatus("ready")
      setError("")
      // A concurrent failed refresh may have cleared the list; the authorized
      // switch response is enough to keep its project visible.
      const known = projectsRef.current
      const next = known.some(project => project.id === current.id)
        ? known.map(project => project.id === current.id ? current : project)
        : [current, ...known]
      projectsRef.current = next
      setProjects(next)
      adopt(current.id)
      return true
    } catch (failure) {
      if (request.signal.aborted || !switchGate.isCurrent(request.ticket)) return false
      if (failure instanceof ProjectsClientError && failure.status === 401) {
        listGate.cancel()
        forget()
        setStatus("anonymous")
        setSwitchError("会话已失效，请重新登录。")
        return false
      }
      if (failure instanceof ProjectsClientError && (failure.status === 403 || failure.status === 404)) {
        listGate.cancel()
        const remaining = projectsRef.current.filter(project => project.id !== projectId)
        setProjects(remaining)
        projectsRef.current = remaining
        if (currentId.current === projectId) {
          const fallback = remaining[0] ?? null
          if (fallback) adopt(fallback.id)
          else forget()
        }
        setGeneration(value => value + 1)
        setSwitchError("该项目已无访问权限。")
        return false
      }
      setSwitchError(failure instanceof ProjectsClientError ? failure.message : "项目切换失败，请重试。")
      return false
    } finally {
      // A newer switch owns the busy flag; the latest switch always clears it,
      // even when its own request was aborted after the catch returned early.
      if (switchGate.isCurrent(request.ticket)) {
        setSwitching(false)
        switchGate.finish(request.ticket)
      }
    }
  }, [adopt, forget, listGate, registry, switchGate])

  const createProject = useCallback(async (input: ProjectCreatePayload) => {
    setSwitchError("")
    setSwitchFailures([])
    if (registry) {
      const saved = await registry.saveAll()
      if (!saved.ok) {
        setSwitchFailures(saved.failures)
        setSwitchError("存在未保存的修改，新建项目已取消。")
        throw new ProjectsClientError(409, "存在未保存的修改，请先保存后再新建项目。")
      }
    }
    // Cancel an in-flight list refresh so an older response cannot hide the new project.
    listGate.cancel()
    const project = await client.create(input)
    setStatus("ready")
    setCanCreateProject(true)
    setError("")
    const list = [project, ...projectsRef.current.filter(existing => existing.id !== project.id)]
    projectsRef.current = list
    reconcile(list, project.id)
    return project
  }, [listGate, reconcile, registry])

  const currentProject = projects.find(project => project.id === currentProjectId) ?? null
  const value = useMemo<ProjectHostValue>(() => ({
    status,
    projects,
    currentProject,
    canCreateProject,
    error,
    generation,
    switching,
    switchFailures,
    switchError,
    refresh: load,
    selectProject,
    createProject,
  }), [status, projects, currentProject, canCreateProject, error, generation, switching, switchFailures, switchError, load, selectProject, createProject])

  return <ProjectHostContext.Provider value={value}>{children}</ProjectHostContext.Provider>
}

export function useProjectHost(): ProjectHostValue {
  const value = useContext(ProjectHostContext)
  if (!value) throw new Error("ProjectHostProvider is missing")
  return value
}
