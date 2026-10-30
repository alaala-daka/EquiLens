import "server-only"
import { requireAccount } from "../auth/access"
import { applicationDatabase } from "../database/runtime"
import { FactRepository } from "../facts/repository"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { resultHttpServices } from "../results/access"
import { LetterService } from "./service"

export async function lettersHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return {
    identity: requireAccount,
    authorize: requireProjectAccess,
    service: new LetterService({ results: results.service, facts: new FactRepository(database),
      readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null }),
  }
}
