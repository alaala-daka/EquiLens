import "server-only"
import { requireAccount } from "../auth/access"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { resultHttpServices } from "../results/access"
import { OcrRepository } from "./ocr-repository"
import { VerificationRecordRepository } from "./records-repository"
import { VerificationService } from "./service"

/**
 * C4-VERIFY production wiring (server-only).
 *
 * The HTTP services reuse the project-authorization entry points and the
 * production ResultService (whose machine-only/server-owned sets and validators
 * are registered by the Lead's integration). Requirement fields are read only
 * through C4-OCR's `FieldSource` implementation (`OcrRepository`) — verify code
 * never queries the field tables directly.
 */
export async function verificationHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  return {
    identity: requireAccount,
    authorize: requireProjectAccess,
    service: new VerificationService({
      materials: new MaterialRepository(database),
      results: results.service,
      records: new VerificationRecordRepository(database),
      fieldSource: new OcrRepository(database),
      readProjectRetention: async projectId => (await projects.findActive(projectId))?.retentionUntil ?? null,
    }),
  }
}
