import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connectDatabase } from "../../database/connection"
import { DocumentRepository } from "../../documents/repository"
import { DocumentSessionRepository } from "../../documents/session-repository"
import { retentionPolicy } from "../../documents/retention-policy"
import { blankDocx } from "../../../lib/documents/docx"
import { ReviewTaskRepository, type TaskInput } from "./repository"
import { testPack } from "../../../../tools/contract-review/tests/helpers"
import type { SubmitReview } from "../../../lib/contract-reviews/types"

export async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "equilens-review-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  let clock = new Date()
  const sessions = new DocumentSessionRepository(database, { now: () => clock, readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }) })
  const documents = new DocumentRepository(database, sessions)
  const token = createHash("sha256").update(randomUUID()).digest("hex")
  const owner = createHash("sha256").update(token).digest("hex")
  const initial = await sessions.view(owner)
  const saved = await documents.create(owner, { blob: blankDocx(), title: "合成合同", source: "authored", prompt: "", retentionConsent: initial.confirmation! })
  const contextId = initial.contextId
  const repository = new ReviewTaskRepository(database, sessions)
  await repository.initialize()
  const request: SubmitReview = { documentId: saved.document.id, revisionId: saved.revision.id, context: { scene: "mep-sub-2026", region: "上海" }, externalProcessingConsent: true, unreviewedMaterialsConsent: true, configurationId: "0".repeat(64) }
  const input: TaskInput = { ...request, documentContextId: contextId, title: saved.document.title, revisionHash: saved.revision.hash,
    pack: testPack(), packSha256: "1".repeat(64), skill: { id: "contract-review", name: "合成", description: "合成测试", version: "test", instructions: "仅合成测试", sha256: "2".repeat(64) },
    mode: "debug", model: "synthetic", baseURL: "https://model.invalid/v1", maxPromptChars: 24000, consentAt: clock.toISOString() }
  return { token, database, sessions, repository, owner, contextId, request, input, saved,
    create: (key = randomUUID()) => repository.create(owner, key, request, input, 3, 7),
    setClock: (value: Date) => { clock = value },
    close: async () => { await database.close(); await rm(directory, { recursive: true }) } }
}
