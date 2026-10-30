import "server-only"
import { requireAccount } from "../auth/access"
import { authConfig } from "../auth/config"
import { applicationDatabase } from "../database/runtime"
import { validateUpload } from "../documents/validate"
import { requireProjectAccess } from "../projects/access"
import { ProjectRepository } from "../projects/repository"
import { BusinessError } from "../projects/errors"
import { privateObjectStoreRuntime } from "../storage/runtime"
import { MaterialRepository } from "./repository"
import { ProjectDocumentRepository } from "./document-repository"
import { ProjectEditorService } from "./editor"
import type { ProjectEditorHttpDependencies } from "./editor-http"

export async function projectEditorServices(): Promise<ProjectEditorHttpDependencies> {
  const db = await applicationDatabase(), projects = new ProjectRepository(db)
  return { requireAccount, origin: () => authConfig(process.env).origin, editor: new ProjectEditorService({
    repository: new ProjectDocumentRepository(db), materials: new MaterialRepository(db), store: privateObjectStoreRuntime(), authorize: requireProjectAccess,
    retentionUntil: async id => { const project = await projects.findActive(id); if (!project) throw new BusinessError("NOT_FOUND", "找不到该项目。"); return project.retentionUntil },
    validate: async bytes => { try { await validateUpload(bytes) } catch { throw new BusinessError("INVALID_SOURCE", "Word 文件无效或包含不支持的内容。") } },
  }) }
}

/** Bounded maintenance hook for the explicit Node runtime lifecycle. */
export async function repairProjectDocumentWrites(limit = 10): Promise<number> {
  return (await projectEditorServices()).editor.repairWrites(limit)
}
