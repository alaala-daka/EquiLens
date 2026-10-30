import type { Database } from "../database/connection"
import { AuthService } from "../auth/service"
import { PublicationService } from "./publication"
import { KnowledgeRepository } from "./repository"

/**
 * Runtime wiring for the private publication maintenance CLI.
 *
 * The CLI (scripts/knowledge-maintenance.mts) explicitly connects and migrates
 * the database, then builds this service. Nothing here runs on module import,
 * and no HTTP route exposes publication writes (spec/01 §7.1).
 */
export function createMaintenanceService(
  database: Database,
  env: Record<string, string | undefined>,
  options: { now?: () => Date; id?: () => string } = {},
): PublicationService {
  return new PublicationService({
    repository: new KnowledgeRepository(database, options),
    auth: new AuthService(database),
    env,
    ...(options.now ? { now: options.now } : {}),
  })
}
