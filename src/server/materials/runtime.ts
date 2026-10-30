import { ProjectRepository } from "../projects/repository"
import { createMaterialLifecycle, recoverAuthorizedMaterial } from "./lifecycle"
import "server-only"
import { applicationDatabase } from "../database/runtime"
import { authorizeTaskExecution } from "../projects/access"
import { privateObjectStoreRuntime } from "../storage/runtime"
import { registerTaskExecutor } from "../tasks/executors"
import { taskRepository } from "../tasks/service"
import { createMaterialExecutor } from "./executor"
import { MaterialRepository } from "./repository"
import { repairProjectDocumentWrites } from "./editor-runtime"
import { repairProductionExports } from "../exports/export-runtime"

const global = globalThis as typeof globalThis & { materialMaintenance?: { timer?: ReturnType<typeof setTimeout>; started: boolean } }
/** Called only by the explicit Node lifecycle, before the unified runner starts. */
export function startMaterialRuntime() {
  if (global.materialMaintenance?.started) return
  const state = global.materialMaintenance = { started: true } as NonNullable<typeof global.materialMaintenance>
  const register = () => registerTaskExecutor("material-parse", async (job, context) => {
    const repository = new MaterialRepository(await applicationDatabase())
    return createMaterialExecutor({ repository, store: privateObjectStoreRuntime(), readProjectRetention: async id => (await new ProjectRepository(await applicationDatabase()).findActive(id))?.retentionUntil ?? null })(job, context)
  })
  const repair = async () => {
    try {
      const repository = new MaterialRepository(await applicationDatabase())
      const result = await repository.uploadIntents().repair({
        store: privateObjectStoreRuntime(),
        isReferenced: intent => repository.objectReferenced(intent.objectKey),
        // Certificate images are parse-less terminal intents; recovery must never
        // re-enqueue material-parse for them.
        isParseRequired: async intent => (await repository.findMaterial(intent.projectId, intent.materialId))?.format !== "image",
        enqueueParse: async intent => recoverAuthorizedMaterial(
          () => authorizeTaskExecution({ accountId: intent.accountId, projectId: intent.projectId, action: "edit" }), async () => {

          const version = await repository.versionById(intent.projectId, intent.versionId)
          if (!version) throw Error("MATERIAL_VERSION_MISSING")
          const { task } = await (await taskRepository()).submit(intent.accountId, `material:${version.id}`, { kind: "material-parse", projectId: intent.projectId, refs: { materials: [{ materialVersionId: version.id, sha256: version.sha256 }] }, conditions: {} })
          await repository.linkTask(intent.projectId, intent.materialId, task.id)
          return task.id
        }),
      }, { limit: 10 })
      if (result.remaining) console.error("Material recovery incomplete")
    } catch { console.error("Material recovery unavailable") }
    for (const action of [repairProjectDocumentWrites, repairProductionExports]) {
      try { await action(10) } catch { console.error("Private artifact recovery unavailable") }
    }

  }
  createMaterialLifecycle({ register, repair, report: () => console.error("Material maintenance unavailable"), schedule: callback => { state.timer = setTimeout(callback, 60_000); state.timer.unref() } }).start()
}
