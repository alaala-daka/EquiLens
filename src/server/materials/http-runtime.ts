import "server-only"
import { requireAccount } from "../auth/access"
import { authConfig } from "../auth/config"
import { applicationDatabase } from "../database/runtime"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { BusinessError } from "../projects/errors"
import { validateUpload } from "../documents/validate"
import { createUnavailableObjectStore } from "../storage/obs"
import { submitTask } from "../tasks/service"
import { taskExecutorRegistry } from "../tasks/executors"
import { MaterialRepository } from "./repository"
import { MaterialService } from "./service"
import { QueuedMaterialService } from "./queued"
import type { MaterialHttpDependencies } from "./http"

export async function materialHttpServices(): Promise<MaterialHttpDependencies> {
  const database = await applicationDatabase()
  const projects = new ProjectRepository(database)
  const deps = { repository: new MaterialRepository(database), store: createUnavailableObjectStore(), requireProjectAccess,
    readProject: (id: string) => projects.findActive(id) }
  return {
    requireAccount, origin: () => authConfig(process.env).origin,
    reads: new MaterialService(deps),
    writes: new QueuedMaterialService({ ...deps,
      available: () => !!taskExecutorRegistry.get("material-parse"),
      preflight: async (bytes, format) => {
        if (format === "docx") {
          try { await validateUpload(Buffer.from(bytes)) } catch { throw new BusinessError("INVALID_SOURCE", "Word 文件无效或包含不支持的内容。") }
        } else if (/\/Encrypt\b/.test(Buffer.from(bytes).toString("latin1"))) throw new BusinessError("INVALID_SOURCE", "不支持加密 PDF。")
      },
      enqueue: async (identity, version, operationId) => (await submitTask(identity, requireProjectAccess, { projectId: version.projectId, kind: "material-parse", operationId, refs: { materials: [{ materialVersionId: version.id, sha256: version.sha256 }] }, conditions: {} })).task.id,
    }),
  }
}
