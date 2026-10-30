import "server-only"
import { applicationDatabase } from "../database/runtime"
import { resultHttpServices } from "../results/access"
import { privateObjectStoreRuntime } from "../storage/runtime"
import { ExportRepository } from "./repository"
import { ExportService } from "./service"
import { productionExportTemplates } from "./template"

/**
 * Export retention deadline.
 *
 * A result may carry fragment sources (contract-review) and/or material
 * dependencies (C4 verification, where evidence fields have no parse fragment).
 * The deadline is the earliest of the project retention, every source snapshot's
 * material retention and every dependency material version retention; any
 * unresolvable source/dependency fails closed instead of extending retention.
 */
export async function exportHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  const retention = async (ref: import("../../lib/business/contracts").ResultRevisionRef) => database.transaction(async c => {
    const project = (await c.query("SELECT retention_until FROM equilens_projects WHERE id=$1 AND status='active'",[ref.projectId])).rows[0]
    const version = (await c.query("SELECT sources_json FROM equilens_result_versions WHERE project_id=$1 AND result_id=$2 AND id=$3 AND sha256=$4",[ref.projectId,ref.resultId,ref.versionId!,ref.sha256!])).rows[0]
    if (!project || !version) return null
    const deadlines = [Date.parse(String(project.retention_until))]
    for (const source of JSON.parse(String(version.sources_json)) as { snapshotId: string }[]) {
      const material = (await c.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_parse_snapshots s ON s.material_id=m.id AND s.project_id=m.project_id WHERE s.project_id=$1 AND s.id=$2 AND m.status='active'",[ref.projectId,source.snapshotId])).rows[0]
      if (!material) return null
      deadlines.push(Date.parse(String(material.retention_until)))
    }
    const dependencies = (await c.query("SELECT dependency_version_id FROM equilens_result_dependencies WHERE project_id=$1 AND result_id=$2 AND version_id=$3 AND dependency_kind='material'",[ref.projectId,ref.resultId,ref.versionId])).rows
    for (const dependency of dependencies) {
      const material = (await c.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_material_versions v ON v.material_id=m.id AND v.project_id=m.project_id WHERE m.project_id=$1 AND v.id=$2 AND m.status='active'",[ref.projectId,String(dependency.dependency_version_id)])).rows[0]
      if (!material) return null
      deadlines.push(Date.parse(String(material.retention_until)))
    }
    return deadlines.every(Number.isFinite) ? new Date(Math.min(...deadlines)).toISOString() : null
  })
  return { identity: results.identity,authorize: results.authorize,service: new ExportService(new ExportRepository(await applicationDatabase()),results.service,privateObjectStoreRuntime(),productionExportTemplates(),retention) }
}
