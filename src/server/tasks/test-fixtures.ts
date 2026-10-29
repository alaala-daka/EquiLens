import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connectDatabase, type Database } from "../database/connection"
import type { TaskKind, TaskRequest } from "./catalog"
import { TaskRepository, type TaskBudgetReservation, type TaskRepositoryOptions } from "./repository"
import { statements } from "./schema"

export const projectId = "project-1"
const otherProjectId = "project-2"

function ref(id: string, project = projectId) {
  return { projectId: project, id, versionId: `${id}-version` }
}

function material(id: string) {
  return { materialVersionId: id, sha256: "a".repeat(64) }
}

export const reviewConditions = {
  scene: "auto" as const,
  role: "专业分包人" as const,
  region: "上海",
  externalProcessingConsent: true as const,
  unreviewedMaterialsConsent: true,
}

export function reviewRequest(project = projectId) {
  return {
    kind: "contract-review" as const,
    projectId: project,
    refs: { materials: [material("material-1")] },
    conditions: { ...reviewConditions },
  }
}

/** A syntactically valid submission for each controlled kind. */
export function validRequest(kind: TaskKind): TaskRequest {
  switch (kind) {
    case "contract-review":
      return reviewRequest()
    case "document-analysis":
      return { kind, projectId, refs: { document: ref("document-1") }, conditions: {} }
    case "payment-reconciliation":
      return { kind, projectId, refs: { document: ref("document-1"), facts: [ref("facts-1")] }, conditions: { asOf: "2026-10-28" } }
    case "evidence-organization":
      return { kind, projectId, refs: { facts: [ref("facts-1")] }, conditions: {} }
    case "collection-letter":
      return { kind, projectId, refs: { facts: [ref("facts-1")], ledger: ref("ledger-1") }, conditions: { asOf: "2026-10-28" } }
    case "material-parse":
      return { kind, projectId, refs: { materials: [material("material-1")] }, conditions: {} }
    case "bid-requirements":
      return { kind, projectId, refs: { materials: [material("material-1")] }, conditions: { externalProcessingConsent: true } }
    case "certificate-ocr":
      return {
        kind, projectId,
        refs: { materials: [material("material-image-1")] },
        conditions: { certificateKind: "enterprise_license", externalProcessingConsent: true },
      }
    case "bid-verification":
      return {
        kind, projectId,
        refs: {
          materials: [material("material-1")],
          requirementSet: { id: "requirements-1", versionId: "requirements-version-1", sha256: "a".repeat(64) },
        },
        conditions: { asOf: "2026-10-28" },
      }
    case "result-export":
      return { kind, projectId, refs: { result: ref("result-1") }, conditions: { format: "docx" } }
  }
}

export { ref, material, otherProjectId }

export type TaskTestOptions = TaskRepositoryOptions & {
  /** Build the A3b budget gate against the test database. */
  budgetFactory?: (database: Database) => TaskBudgetReservation
}

export type TaskFixture = {
  readonly database: Database
  readonly repository: TaskRepository
  readonly path: string
  /** Close and reopen the SQLite file with fresh repository instances (process restart). */
  reopen(options?: TaskTestOptions): Promise<TaskFixture>
  close(): Promise<void>
}

async function openTasks(path: string, options: TaskTestOptions) {
  const database = await connectDatabase({ provider: "sqlite", path })
  await database.transaction(async connection => {
    for (const sql of statements) await connection.query(sql)
  })
  const { budgetFactory, ...repositoryOptions } = options
  const budget = budgetFactory ? budgetFactory(database) : repositoryOptions.budget
  const repository = new TaskRepository(database, { ...repositoryOptions, ...(budget ? { budget } : {}) })
  return { database, repository }
}

export async function setupTasks(options: TaskTestOptions = {}): Promise<TaskFixture> {
  const directory = await mkdtemp(join(tmpdir(), "equilens-tasks-"))
  const path = join(directory, "tasks.sqlite")
  let opened = await openTasks(path, options)
  const fixture: TaskFixture = {
    get database() { return opened.database },
    get repository() { return opened.repository },
    path,
    async reopen(next: TaskTestOptions = options): Promise<TaskFixture> {
      await opened.database.close()
      opened = await openTasks(path, next)
      return fixture
    },
    async close() {
      await opened.database.close()
      await rm(directory, { recursive: true })
    },
  }
  return fixture
}

export function submission(kind: TaskKind = "contract-review", operationId = "operation-1") {
  return { ...validRequest(kind), operationId }
}
