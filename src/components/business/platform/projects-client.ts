import type { ProjectRole } from "@/lib/business/contracts"

/** Client-side view of the C1 project API. Private responses are never cached. */
export type ProjectSource = "synthetic" | "authorized"

export type ProjectSummary = {
  id: string
  name: string
  source: ProjectSource
  purpose: string
  retentionUntil: string
  role: ProjectRole
  createdAt: string
  updatedAt: string
}

export type ProjectList = { projects: ProjectSummary[]; canCreateProject: boolean }

export type ProjectCreatePayload = {
  name: string
  source: ProjectSource
  sourceReference: string
  purpose: string
  retentionUntil: string
}

export class ProjectsClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "ProjectsClientError"
  }
}

const fallback: Record<number, string> = {
  400: "请求内容无效。",
  401: "会话已失效，请重新登录。",
  403: "无权访问该项目。",
  404: "找不到该项目。",
  409: "操作与当前状态冲突。",
  429: "请求过于频繁，请稍后重试。",
  503: "服务暂不可用，请稍后重试。",
}

export function createProjectsClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetcher(path, { ...init, cache: "no-store", credentials: "same-origin" })
    } catch {
      throw new ProjectsClientError(0, "网络连接失败，请重试。")
    }
    if (!response.ok) {
      let message = fallback[response.status] ?? "请求失败，请稍后重试。"
      try {
        const body = await response.json() as { error?: { message?: unknown } }
        const errorMessage = body?.error?.message
        if (typeof errorMessage === "string" && errorMessage) message = errorMessage
      } catch {
        // Keep the fixed status message; never echo a non-JSON body.
      }
      throw new ProjectsClientError(response.status, message)
    }
    return response
  }

  return {
    async list(signal?: AbortSignal): Promise<ProjectList> {
      const body = await (await request("/api/projects", { signal })).json() as ProjectList
      if (!body || !Array.isArray(body.projects) || typeof body.canCreateProject !== "boolean") {
        throw new ProjectsClientError(0, "项目列表不可用，请重试。")
      }
      return body
    },
    async create(input: ProjectCreatePayload, signal?: AbortSignal): Promise<ProjectSummary> {
      const response = await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      })
      const body = await response.json() as { project?: ProjectSummary }
      if (!body?.project) throw new ProjectsClientError(0, "创建项目失败，请重试。")
      return body.project
    },
    /** Fresh authorization check for an explicit project switch. */
    async get(projectId: string, signal?: AbortSignal): Promise<ProjectSummary> {
      const body = await (await request(`/api/projects/${encodeURIComponent(projectId)}`, { signal })).json() as { project?: ProjectSummary }
      if (!body?.project) throw new ProjectsClientError(0, "项目不可用，请重试。")
      return body.project
    },
  }
}
