import "server-only"
import { applicationDatabase } from "../database/runtime"
import { MaterialRepository } from "../materials/repository"
import { ProjectRepository } from "../projects/repository"
import { privateObjectStoreRuntime } from "../storage/runtime"
import type { TaskExecutor } from "../tasks/runner-core"
import { createOcrAdapter, type OcrAdapter } from "./ocr"
import { createCertificateOcrExecutor, registerCertificateOcrCapability } from "./ocr-executor"
import { OcrRepository } from "./ocr-repository"

const state = globalThis as typeof globalThis & { equilensOcrRuntimeStarted?: boolean }

async function ocrRepository(): Promise<OcrRepository> {
  return new OcrRepository(await applicationDatabase())
}

function projectOcrExecutor(adapter: OcrAdapter): TaskExecutor {
  const replayOcr: Pick<OcrRepository, "beginRun" | "finishRun" | "completeRun"> = {
    beginRun: async input => (await ocrRepository()).beginRun(input),
    finishRun: async input => (await ocrRepository()).finishRun(input),
    completeRun: async input => (await ocrRepository()).completeRun(input),
  }
  const materialRepository = async () => new MaterialRepository(await applicationDatabase())
  return createCertificateOcrExecutor({
    adapter,
    repository: {
      versionById: async (projectId, versionId) => (await materialRepository()).versionById(projectId, versionId),
      findMaterial: async (projectId, materialId) => (await materialRepository()).findMaterial(projectId, materialId),
    },
    ocr: replayOcr,
    store: { get: async key => privateObjectStoreRuntime().get(key) },
    readProjectRetention: async projectId => (await new ProjectRepository(await applicationDatabase()).findActive(projectId))?.retentionUntil ?? null,
  })
}

/**
 * C4-OCR explicit Node lifecycle entry. src/instrumentation.ts must call this
 * before startTaskRunner() so a queued certificate-ocr task is never claimed
 * without its executor. Importing this module starts nothing.
 *
 * Capability is server-controlled and fail-closed:
 *  - the default adapter is `createOcrAdapter(process.env)`, which returns an
 *    unavailable adapter unless a verified provider and a measured certificate
 *    kind list exist (today it is always unavailable);
 *  - when unavailable (or when no kind has been measured) the `certificate-ocr`
 *    executor is NOT registered, so `POST /api/tasks` answers 503 and no task is
 *    persisted;
 *  - when available, a kind admission hook rejects certificate kinds outside
 *    `supportedKinds()` with 422 before persistence, and the executor re-checks
 *    the kind before any external request.
 *
 * No database query or object-storage access happens during registration. The
 * synthetic test adapter is injected only through this explicit entry (or
 * `registerCertificateOcrCapability` directly); production modules never import
 * it.
 */
export function startOcrRuntime(options: { env?: Record<string, string | undefined>; adapter?: OcrAdapter } = {}): void {
  if (state.equilensOcrRuntimeStarted) return
  state.equilensOcrRuntimeStarted = true
  registerOcrCapability(options.adapter ?? createOcrAdapter(options.env ?? process.env))
}

/** Register (or deliberately not register) the verified OCR capability. */
export function registerOcrCapability(adapter: OcrAdapter): void {
  registerCertificateOcrCapability(adapter, projectOcrExecutor)
}
