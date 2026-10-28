import "server-only"
import { applicationDatabase } from "../database/runtime"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { createUnavailableObjectStore } from "../storage/obs"
import { MaterialRepository } from "./repository"
import { MaterialService } from "./service"

/**
 * Server-only material wiring. The private object adapter is intentionally a
 * fail-closed placeholder until a verified OBS adapter exists; local tests and
 * synthetic flows inject the in-memory store instead of presenting it as OBS.
 */
async function load(): Promise<MaterialService> {
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return new MaterialService({
    repository: new MaterialRepository(database),
    store: createUnavailableObjectStore(),
    requireProjectAccess,
    readProject: async projectId => {
      const project = await projects.findActive(projectId)
      return project ? { retentionUntil: project.retentionUntil } : null
    },
  })
}

let cached: Promise<MaterialService> | undefined

export function materialService(): Promise<MaterialService> {
  if (!cached) {
    cached = load().catch(failure => {
      cached = undefined
      throw failure
    })
  }
  return cached
}
