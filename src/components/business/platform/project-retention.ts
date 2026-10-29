/** Refreshes may update access metadata, but never choose a different workspace. */
export function workspaceRoute(status: string, currentProject: { id: string } | null) {
  return currentProject ? "project" : status === "anonymous" ? "anonymous" : "loading"
}

/** The anonymous workspace stays reachable while signed in; project mode is only the default. */
export function workspaceSurface(anonymous: boolean, status: string, currentProject: { id: string } | null) {
  return anonymous ? "anonymous" : workspaceRoute(status, currentProject)
}

export function retainProject<T extends { id: string }>(current: T | null, refreshed: T[] | null) {
  if (!refreshed) return { project: current, blocked: true }
  if (current) {
    const updated = refreshed.find(project => project.id === current.id)
    return { project: updated ?? current, blocked: !updated }
  }
  return { project: refreshed[0] ?? null, blocked: false }
}
