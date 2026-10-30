import "server-only"
import { requireAccount } from "../auth/access"
import { applicationDatabase } from "../database/runtime"
import { FactRepository } from "../facts/repository"
import { MaterialRepository } from "../materials/repository"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { resultHttpServices } from "../results/access"
import { EvidenceProjectService } from "./project-service"
import { EvidenceRepository } from "./repository"

/** 项目证据服务复用生产成果服务（校验器与 serverOwned 集合），不自建无集合的 ResultService。 */
export async function evidenceHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return {
    identity: requireAccount,
    authorize: requireProjectAccess,
    service: new EvidenceProjectService({
      repository: new EvidenceRepository(database),
      materials: new MaterialRepository(database),
      facts: new FactRepository(database),
      results: results.service,
      readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null,
    }),
  }
}
