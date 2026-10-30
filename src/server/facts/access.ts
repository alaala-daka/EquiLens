import "server-only"
import { requireAccount } from "../auth/access"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { FactRepository } from "./repository"
import { FactService } from "./service"

export async function factsHttpServices() {
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return { identity: requireAccount, authorize: requireProjectAccess, service: new FactService({ facts: new FactRepository(database), materials: new MaterialRepository(database),
    readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null }) }
}
