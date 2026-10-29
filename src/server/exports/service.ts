import { createHash, randomUUID } from "node:crypto"
import type { ExportRef, ResultRevisionRef } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import type { Row } from "../database/connection"
import { BusinessError } from "../projects/errors"
import { type ResultAuthorizer, type ResultDependency, ResultService } from "../results/service"
import { canonicalJson } from "../results/validation"
import { exportObjectKey, type PrivateObjectStore } from "../storage/obs"
import { ExportRepository } from "./repository"
import { docxContentType, renderDocx, renderVersion } from "./renderer"

export type RetentionResolver = (ref: ResultRevisionRef) => Promise<string | null>
type Template = {
  version: string
  paragraphs(value: unknown): string[]
  /** Server-owned kinds whose export must not be produced from an invalid result. */
  requiresValidResult?: boolean
}
export class ExportTemplateRegistry {
  constructor(private readonly templates = new Map<string,Template>()) {}
  require(kind: string) {
    const template = this.templates.get(kind)
    if (!template) throw new BusinessError("SERVICE_UNAVAILABLE","该成果类型尚未开放导出。")
    return template
  }
}
export type DependencyChange = { dependency: ResultDependency; originalVersion: string; currentVersion: string | null; status: "unchanged" | "changed" | "unknown" }
export type CurrentVersionResolver = (projectId: string, dependency: ResultDependency) => Promise<string | null>
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function reference(row: Row): ExportRef {
  return { projectId: String(row.project_id),resultId: String(row.result_id),versionId: String(row.version_id),sha256: String(row.result_sha256),exportId: String(row.id),format: "docx",createdAt: String(row.created_at) }
}

export class ExportService {
  constructor(private readonly repository: ExportRepository, private readonly results: ResultService, private readonly store: PrivateObjectStore, private readonly templates: ExportTemplateRegistry, private readonly retention: RetentionResolver, private readonly pendingGraceMs = 600_000) {}
  private async access(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, action: "read" | "edit") {
    const access = await authorize(identity,projectId,action)
    if (access.projectId !== projectId || action === "edit" && access.role === "viewer") throw new BusinessError("FORBIDDEN","无权操作该导出。")
    return access
  }
  async createExport(identity: AuthIdentity, authorize: ResultAuthorizer, ref: ResultRevisionRef): Promise<ExportRef> {
    const access = await this.access(identity,authorize,ref.projectId,"edit")
    if (!ref.versionId || !ref.sha256) throw new BusinessError("INVALID_INPUT","导出版本无效。")
    const selected = await this.results.get(identity,authorize,ref.projectId,ref.resultId,ref.versionId)
    if (selected.sha256 !== ref.sha256) throw new BusinessError("CONFLICT","成果摘要已变化。")
    const template = this.templates.require(selected.kind)
    const validation = await this.results.validateResult(identity,authorize,ref)
    if (template.requiresValidResult && validation.status !== "valid") throw new BusinessError("INVALID_SOURCE","成果校验未通过，无法导出。")
    const approved = validation.status === "valid" && selected.review?.decision === "approved"
    const paragraphs = template.paragraphs(selected.value)
    if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some(p => typeof p !== "string")) throw new BusinessError("INVALID_INPUT","导出正文无效。")
    const metadata = ["AI 辅助生成",`成果编号：${ref.resultId}`,`保存版本：${ref.versionId}`,approved ? "已复核" : "草稿 · 待复核",`校验：${validation.status}`,`复核：${selected.review?.decision ?? "pending"}`,`模板：${template.version}`,`渲染：${renderVersion}`,...validation.issues.map(issue => `未解决：${issue.code} ${issue.message}`),...selected.sources.map(source => `来源：${source.snapshotId}/${source.fragmentId} ${source.quote}`)]
    const snapshot = { selected,validation,templateVersion: template.version,renderVersion,paragraphs,metadata }
    const bytes = renderDocx({ paragraphs,metadata }), sha256 = digest(bytes), exportId = randomUUID()
    const key = exportObjectKey({ projectId: ref.projectId,exportId,sha256 })
    await this.access(identity,authorize,ref.projectId,"edit")
    const retentionUntil = await this.retention(ref)
    if (!retentionUntil || !Number.isFinite(Date.parse(retentionUntil)) || Date.parse(retentionUntil) <= Date.now()) throw new BusinessError("SERVICE_UNAVAILABLE","导出保留期限无效。")
    const previous = (await this.repository.list(ref.projectId,ref.resultId)).filter(row => row.version_id === ref.versionId && (row.template_version !== template.version || row.render_version !== renderVersion)).at(-1)
    const row: Row = { id: exportId,project_id: ref.projectId,result_id: ref.resultId,version_id: ref.versionId,result_sha256: ref.sha256,sha256,object_key: key,format: "docx",template_version: template.version,render_version: renderVersion,snapshot_json: canonicalJson(snapshot),supersedes_id: previous?.id ?? null,state: "pending",purpose: "result-export",retention_until: new Date(retentionUntil).toISOString(),created_by: access.identity.account.id,created_at: new Date().toISOString() }
    await this.repository.insert(row)
    const stored = await this.store.put({ key,bytes,contentType: docxContentType })
    if (stored.key !== key || stored.sha256 !== sha256 || stored.size !== bytes.byteLength) throw new BusinessError("SERVICE_UNAVAILABLE","导出保存失败。")
    await this.access(identity,authorize,ref.projectId,"edit")
    await this.repository.createReady(ref.projectId,exportId)
    return reference(row)
  }
  async repairPending(now = Date.now()) {
    const failures: unknown[] = []
    if (!Number.isFinite(this.pendingGraceMs) || this.pendingGraceMs < 0) throw new Error("Invalid pending grace")
    for (const row of await this.repository.pending()) {
      try {
      await this.repository.attempted(String(row.project_id),String(row.id))
      const current = await this.retention({ projectId: String(row.project_id),resultId: String(row.result_id),versionId: String(row.version_id),sha256: String(row.result_sha256) })
      const deadline = Math.min(Date.parse(String(row.retention_until)),Date.parse(String(row.created_at)) + this.pendingGraceMs,current ? Date.parse(current) : 0)
      if (Number.isFinite(deadline) && now < deadline) continue
      await this.repository.abort(String(row.project_id),String(row.id))
      } catch (error) { failures.push(error) }
    }
    // Claim the terminal state before deleting; failed deletes remain retryable.
    for (const row of await this.repository.aborted()) {
      try {
        await this.repository.attempted(String(row.project_id),String(row.id))
        await this.store.delete(String(row.object_key))
        await this.repository.clear(String(row.project_id),String(row.id))
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures,"Export cleanup failed")
  }
  async list(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, resultId: string) {
    await this.results.get(identity,authorize,projectId,resultId)
    return (await this.repository.list(projectId,resultId)).map(reference)
  }
  async download(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, resultId: string, exportId: string) {
    await this.access(identity,authorize,projectId,"read")
    const row = await this.repository.get(projectId,resultId,exportId)
    const key = exportObjectKey({ projectId,exportId,sha256: String(row.sha256) })
    if (key !== row.object_key) throw new BusinessError("SERVICE_UNAVAILABLE","导出文件校验失败。")
    const object = await this.store.get(key)
    if (!object || object.sha256 !== row.sha256 || digest(object.bytes) !== row.sha256) throw new BusinessError("SERVICE_UNAVAILABLE","导出文件校验失败。")
    await this.access(identity,authorize,projectId,"read")
    return object.bytes
  }
  async queryDependencyChanges(identity: AuthIdentity, authorize: ResultAuthorizer, ref: ResultRevisionRef, resolveCurrentVersion: CurrentVersionResolver): Promise<DependencyChange[]> {
    const selected = await this.results.get(identity,authorize,ref.projectId,ref.resultId,ref.versionId)
    if (!ref.versionId || selected.sha256 !== ref.sha256) throw new BusinessError("CONFLICT","成果版本无效。")
    const changes: DependencyChange[] = []
    for (const dependency of selected.dependencies) {
      const currentVersion = await resolveCurrentVersion(ref.projectId,dependency)
      changes.push({ dependency,originalVersion: dependency.versionId,currentVersion,status: currentVersion === null ? "unknown" : currentVersion === dependency.versionId ? "unchanged" : "changed" })
    }
    return changes
  }
}
