import "server-only"
import { requireAccount } from "../auth/access"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { resultHttpServices } from "../results/access"
import { DraftingInputRepository } from "../templates/repository"
import { DraftingService } from "./service"

/**
 * C5 drafting production wiring (server-only).
 *
 * HTTP services reuse the project-authorization entry points and the production
 * ResultService — whose machine-only/server-owned sets and validators are wired
 * by the Lead's integration — so a draft is written through the same
 * server-owned result path the generic results POST can never reach. Template
 * definitions are code constants; no template table is read or written.
 */
export async function draftingHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return {
    identity: requireAccount,
    authorize: requireProjectAccess,
    service: new DraftingService({
      repository: new DraftingInputRepository(database),
      materials: new MaterialRepository(database),
      results: results.service,
      readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null,
    }),
  }
}
