import { createHash, randomUUID } from "node:crypto"
import type { ProjectAccess, ProjectAction, ResultRevisionRef, ResultReview, ResultValidation } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import type { Connection, Row } from "../database/connection"
import { ResultRepository } from "./repository"
import { canonicalJson, ResultValidatorRegistry } from "./validation"
export type ResultAuthorizer = (identity: AuthIdentity, projectId: string, action: ProjectAction) => Promise<ProjectAccess>
export type ResultSource = { fragmentId: string; snapshotId: string; quote: string }
export type ResultDependency = { kind: "material" | "fact" | "ledger" | "result" | "rule" | "knowledge" | "template"; id: string; versionId: string }
export type SaveResultInput = { projectId: string; resultId?: string; kind: string; baseVersionId: string; operationId: string; reason: string; value: unknown; sources: ResultSource[]; dependencies: ResultDependency[] }
export type ReviewInput = ResultRevisionRef & { decision: ResultReview["decision"]; comment: string }
export type ResultView = ResultRevisionRef & { kind: string; value: unknown; machineOutput: unknown; origin: string; sources: ResultSource[]; dependencies: ResultDependency[]; provenance: { taskId: string; attempt: number; manifest: unknown; manifestHash: string } | null; validation: ResultValidation; review: ResultReview | null; createdAt: string; createdBy: string; reason: string }
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const conflict = () => new BusinessError("CONFLICT", "成果版本已变化，请重新读取后保存。")
const invalid = () => new BusinessError("INVALID_INPUT", "成果输入无效。")
export class ResultService {
  constructor(private readonly repository: ResultRepository, private readonly registry = new ResultValidatorRegistry()) {}
  private async access(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, action: ProjectAction) {
    const access = await authorize(identity, projectId, action)
    if (access.projectId !== projectId || (action !== "read" && access.role === "viewer")) throw new BusinessError("FORBIDDEN", "无权操作该成果。")
    return access
  }
  private async validation(connection: Connection, row: Row): Promise<ResultValidation> {
    const checked = await this.registry.require(String(row.kind))(JSON.parse(String(row.value_json)))
    const issues = [...checked.issues]
    for (const source of JSON.parse(String(row.sources_json)) as ResultSource[]) {
      const fragment = (await connection.query("SELECT * FROM equilens_source_fragments WHERE project_id=$1 AND id=$2 AND snapshot_id=$3", [String(row.project_id), source.fragmentId, source.snapshotId])).rows[0]
      if (!fragment || !String(fragment.text).includes(source.quote) || !source.quote.trim()) issues.push({ code: "INVALID_SOURCE", message: "来源引用无效。", ref: source.fragmentId })
    }
    return { status: issues.length ? "invalid" : checked.status, issues, versionId: String(row.id), checkedAt: new Date().toISOString() }
  }
  private async view(connection: Connection, row: Row): Promise<ResultView> {
    const dependencies = (await connection.query("SELECT dependency_kind,dependency_id,dependency_version_id FROM equilens_result_dependencies WHERE project_id=$1 AND result_id=$2 AND version_id=$3 ORDER BY dependency_kind,dependency_id,dependency_version_id", [String(row.project_id),String(row.result_id),String(row.id)])).rows.map(item => ({ kind: String(item.dependency_kind) as ResultDependency["kind"], id: String(item.dependency_id), versionId: String(item.dependency_version_id) }))
    const reviews = (await connection.query("SELECT review_json FROM equilens_result_reviews WHERE project_id=$1 AND version_id=$2 ORDER BY created_at, id", [String(row.project_id), String(row.id)])).rows
    return { projectId: String(row.project_id), resultId: String(row.result_id), versionId: String(row.id), sha256: String(row.sha256), kind: String(row.kind), value: JSON.parse(String(row.value_json)), machineOutput: row.machine_json ? JSON.parse(String(row.machine_json)) : null, origin: String(row.origin), sources: JSON.parse(String(row.sources_json)), dependencies, provenance: row.provenance_json ? JSON.parse(String(row.provenance_json)) : null, validation: JSON.parse(String(row.validation_json)), review: reviews.length ? JSON.parse(String(reviews.at(-1)!.review_json)) : null, createdAt: String(row.created_at), createdBy: String(row.created_by), reason: String(row.reason) }
  }
  async saveResultRevision(identity: AuthIdentity, authorize: ResultAuthorizer, input: SaveResultInput, machine?: { output: unknown; taskId: string; attempt: number; executionToken: string }): Promise<ResultView> {
    const access = await this.access(identity, authorize, input.projectId, "edit")
    if (machine && input.resultId) throw conflict()
    if (!input.operationId?.trim() || input.operationId.length > 128 || !input.reason?.trim() || !Array.isArray(input.sources) || !Array.isArray(input.dependencies) || typeof input.baseVersionId !== "string") throw invalid()
    for (const source of input.sources) if (!source || typeof source.fragmentId !== "string" || typeof source.snapshotId !== "string" || typeof source.quote !== "string") throw invalid()
    for (const dependency of input.dependencies) if (!dependency || !["material","fact","ledger","result","rule","knowledge","template"].includes(dependency.kind) || typeof dependency.id !== "string" || typeof dependency.versionId !== "string") throw invalid()
    this.registry.require(input.kind)
    const requestHash = hash({ input, machine: machine ? { output: machine.output, taskId: machine.taskId, attempt: machine.attempt } : null })
    return this.repository.transaction(async connection => {
      let provenanceJson: string | null = null
      if (machine) {
        const guarded = await connection.query("UPDATE equilens_tasks SET updated_at=updated_at WHERE id=$1 AND project_id=$2 AND owner=$3 AND attempt=$4 AND execution_token=$5 AND state='running' AND lease_until>$6", [machine.taskId,input.projectId,access.identity.account.id,machine.attempt,machine.executionToken,new Date().toISOString()])
        if (guarded.changes !== 1) throw conflict()
        const task = (await connection.query("SELECT manifest,manifest_hash FROM equilens_tasks WHERE id=$1", [machine.taskId])).rows[0]
        if (!task || typeof task.manifest !== "string" || typeof task.manifest_hash !== "string") throw conflict()
        provenanceJson = canonicalJson({ taskId: machine.taskId, attempt: machine.attempt, manifest: JSON.parse(task.manifest), manifestHash: task.manifest_hash })
      }
      const duplicate = (await connection.query("SELECT * FROM equilens_result_versions WHERE project_id=$1 AND operation_id=$2", [input.projectId, input.operationId])).rows[0]
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw conflict()
        return this.view(connection, { ...duplicate, kind: input.kind })
      }
      const resultId = input.resultId ?? randomUUID()
      let machineJson: string | null = machine ? canonicalJson(machine.output) : null
      if (input.resultId) {
        const previous = await this.repository.version(connection, input.projectId, resultId)
        if (previous.id !== input.baseVersionId || previous.kind !== input.kind) throw conflict()
        machineJson = previous.machine_json === null ? null : String(previous.machine_json)
        provenanceJson = previous.provenance_json === null ? null : String(previous.provenance_json)
      } else if (input.baseVersionId !== "") throw conflict()
      const versionId = randomUUID(), createdAt = new Date().toISOString(), valueJson = canonicalJson(input.value)
      const row: Row = { id: versionId, project_id: input.projectId, result_id: resultId, kind: input.kind, sha256: hash(input.value), value_json: valueJson, machine_json: machineJson, provenance_json: provenanceJson, sources_json: canonicalJson(input.sources), origin: machine ? "machine" : "human", created_at: createdAt, created_by: access.identity.account.id, reason: input.reason }
      row.validation_json = canonicalJson(await this.validation(connection, row))
      if (!input.resultId) await connection.query("INSERT INTO equilens_results(id,project_id,kind,current_version_id,created_at) VALUES($1,$2,$3,$4,$5)", [resultId,input.projectId,input.kind,versionId,createdAt])
      else {
        const updated = await connection.query("UPDATE equilens_results SET current_version_id=$1 WHERE id=$2 AND project_id=$3 AND current_version_id=$4", [versionId,resultId,input.projectId,input.baseVersionId])
        if (updated.changes !== 1) throw conflict()
      }
      await connection.query("INSERT INTO equilens_result_versions(id,project_id,result_id,base_version_id,operation_id,request_hash,sha256,origin,value_json,machine_json,provenance_json,sources_json,validation_json,reason,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [versionId,input.projectId,resultId,input.baseVersionId,input.operationId,requestHash,String(row.sha256),String(row.origin),valueJson,machineJson,provenanceJson,String(row.sources_json),String(row.validation_json),input.reason,access.identity.account.id,createdAt])
      for (const dependency of input.dependencies) await connection.query("INSERT INTO equilens_result_dependencies(id,project_id,result_id,version_id,dependency_kind,dependency_id,dependency_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(),input.projectId,resultId,versionId,dependency.kind,dependency.id,dependency.versionId])
      return this.view(connection,row)
    })
  }
  async get(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, resultId: string, versionId?: string) {
    await this.access(identity,authorize,projectId,"read")
    return this.repository.transaction(async c => this.view(c,await this.repository.version(c,projectId,resultId,versionId)))
  }
  async list(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string) {
    await this.access(identity,authorize,projectId,"read")
    return this.repository.transaction(async c => {
      const rows = (await c.query("SELECT id FROM equilens_results WHERE project_id=$1 ORDER BY created_at",[projectId])).rows
      return Promise.all(rows.map(async row => this.view(c,await this.repository.version(c,projectId,String(row.id)))))
    })
  }
  async validateResult(identity: AuthIdentity, authorize: ResultAuthorizer, ref: ResultRevisionRef) {
    await this.access(identity,authorize,ref.projectId,"read")
    return this.repository.transaction(async c => {
      const row = await this.repository.version(c,ref.projectId,ref.resultId,ref.versionId)
      if (row.sha256 !== ref.sha256) throw conflict()
      return this.validation(c,row)
    })
  }
  async reviewResult(identity: AuthIdentity, authorize: ResultAuthorizer, input: ReviewInput) {
    const access = await this.access(identity,authorize,input.projectId,"edit")
    if (!["approved","rejected","changes_requested"].includes(input.decision) || typeof input.comment !== "string") throw invalid()
    return this.repository.transaction(async c => {
      const row = await this.repository.version(c,input.projectId,input.resultId,input.versionId)
      if (row.id !== row.current_version_id || row.sha256 !== input.sha256) throw conflict()
      const validation = await this.validation(c,row)
      if (input.decision === "approved" && validation.status !== "valid") throw new BusinessError("INVALID_SOURCE","成果校验未通过，无法批准。")
      const review: ResultReview = { versionId: input.versionId,decision: input.decision,comment: input.comment,reviewedBy: access.identity.account.id,reviewedAt: new Date().toISOString() }
      await c.query("INSERT INTO equilens_result_reviews(id,project_id,result_id,version_id,review_json,created_at) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),input.projectId,input.resultId,input.versionId,canonicalJson(review),review.reviewedAt])
      return this.view(c,row)
    })
  }
}
