import { randomUUID } from "node:crypto"
import type { Database, Row } from "../database/connection"
import { assertObjectKey, type PrivateObjectStore } from "../storage/obs"

export type UploadIntent = {
  id: string; projectId: string; materialId: string; versionId: string; objectKey: string; accountId: string
  sourceKind: "synthetic" | "authorized"; sourceReference: string; processingAuthorized: true; purpose: string; retentionUntil: string
  state: "pending" | "stored" | "committed" | "aborted" | "failed"
  parseTaskId: string | null; attempts: number; createdAt: string; updatedAt: string
}
type Input = Pick<UploadIntent, "projectId" | "materialId" | "versionId" | "objectKey" | "accountId" | "sourceKind" | "sourceReference" | "processingAuthorized" | "purpose" | "retentionUntil">
const record = (r: Row): UploadIntent => ({
  id: String(r.id), projectId: String(r.project_id), materialId: String(r.material_id), versionId: String(r.version_id),
  objectKey: String(r.object_key), accountId: String(r.account_id), state: r.state as UploadIntent["state"],
  parseTaskId: r.parse_task_id == null ? null : String(r.parse_task_id), attempts: Number(r.attempts),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  sourceKind: r.source_kind as UploadIntent["sourceKind"], sourceReference: String(r.source_reference), processingAuthorized: Number(r.processing_authorized) === 1 ? true : (() => { throw new Error("Invalid stored upload authorization") })(), purpose: String(r.purpose), retentionUntil: String(r.retention_until),
})

/** Short transactions surround storage I/O; no credentials or document bytes are persisted here. */
export class UploadIntents {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async begin(input: Input): Promise<UploadIntent> {
    if (input.processingAuthorized !== true || !["synthetic", "authorized"].includes(input.sourceKind) || !input.sourceReference.trim() || input.sourceReference.length > 500 || !input.purpose.trim() || input.purpose.length > 500 || !/^\d{4}-\d{2}-\d{2}$/.test(input.retentionUntil) || !Number.isFinite(Date.parse(input.retentionUntil))) throw new Error("Invalid upload authorization")
    assertObjectKey(input.objectKey)
    const parts = input.objectKey.split("/")
    if (parts[1] !== input.projectId || parts[2] !== "materials" || parts[3] !== input.materialId || parts[5] !== input.versionId) throw new Error("Invalid upload identity")
    const timestamp = this.now().toISOString()
    const validate = (value: UploadIntent) => {
      if (value.projectId !== input.projectId || value.materialId !== input.materialId || value.objectKey !== input.objectKey || value.accountId !== input.accountId) throw new Error("Conflicting upload identity")
      for (const field of ["sourceKind", "sourceReference", "processingAuthorized", "purpose", "retentionUntil"] as const) if (value[field] !== input[field]) throw new Error("Conflicting upload authorization")
      return value
    }
    try { return await this.db.transaction(async c => {
      const existing = await c.query("SELECT * FROM equilens_material_upload_intents WHERE version_id=$1", [input.versionId])
      if (!existing.rows.length) await c.query("INSERT INTO equilens_material_upload_intents(id,project_id,material_id,version_id,object_key,account_id,state,parse_task_id,attempts,created_at,updated_at,source_kind,source_reference,processing_authorized,purpose,retention_until) VALUES($1,$2,$3,$4,$5,$6,'pending',NULL,0,$7,$8,$9,$10,1,$11,$12)", [randomUUID(), input.projectId, input.materialId, input.versionId, input.objectKey, input.accountId, timestamp, timestamp, input.sourceKind, input.sourceReference, input.purpose, input.retentionUntil])
      const value = record((await c.query("SELECT * FROM equilens_material_upload_intents WHERE version_id=$1", [input.versionId])).rows[0])
      return validate(value)
    }) } catch (failure) {
      const error = failure as { code?: string; errcode?: number }
      if (error.code !== "23505" && error.errcode !== 1555 && error.errcode !== 2067) throw failure
      const result = await this.db.transaction(c => c.query("SELECT * FROM equilens_material_upload_intents WHERE version_id=$1", [input.versionId]))
      if (!result.rows.length) throw failure
      return validate(record(result.rows[0]))
    }
  }

  async stored(id: string) { await this.update(id, "stored", "pending") }
  async committed(id: string, taskId?: string) {
    await this.db.transaction(c => c.query("UPDATE equilens_material_upload_intents SET state='committed',parse_task_id=COALESCE($1,parse_task_id),updated_at=$2 WHERE id=$3 AND state IN ('pending','stored','committed','failed')", [taskId ?? null, this.now().toISOString(), id]))
  }
  private async update(id: string, state: string, previous: string) {
    await this.db.transaction(c => c.query("UPDATE equilens_material_upload_intents SET state=$1,updated_at=$2 WHERE id=$3 AND state=$4", [state, this.now().toISOString(), id, previous]))
  }
  async open(limit: number): Promise<UploadIntent[]> {
    // Image originals are accepted without a material-parse task and commit as a
    // terminal parse-less intent. They must never be re-enqueued into
    // material-parse by recovery, so the committed parse-less image intents are
    // excluded here as well as guarded inside repair().
    const result = await this.db.transaction(c => c.query("SELECT i.* FROM equilens_material_upload_intents i LEFT JOIN equilens_material_versions v ON v.id=i.version_id WHERE i.state NOT IN ('aborted') AND (i.state <> 'committed' OR i.parse_task_id IS NULL) AND NOT (i.state='committed' AND i.parse_task_id IS NULL AND COALESCE(v.content_type,'') IN ('image/png','image/jpeg')) ORDER BY i.updated_at,i.id LIMIT $1", [Math.max(1, Math.min(100, Math.trunc(limit)))]))
    return result.rows.map(record)
  }

  async repair(deps: {
    store: PrivateObjectStore
    /** Must query committed version references, never infer commitment from intent state. */
    isReferenced: (intent: UploadIntent) => Promise<boolean>
    /** Must reauthorize account/project, then submit using versionId as idempotency key. */
    enqueueParse?: (intent: UploadIntent) => Promise<string>
    /**
     * False for stored versions that have no parse step (certificate images):
     * recovery then commits the intent as terminal instead of submitting a
     * material-parse task that could never succeed.
     */
    isParseRequired?: (intent: UploadIntent) => Promise<boolean>
  }, options: { limit?: number; expiryMs?: number } = {}): Promise<{ resolved: number; remaining: number }> {
    const expiryMs = options.expiryMs ?? 600000
    if (!Number.isFinite(expiryMs) || expiryMs < 0) throw new Error("Invalid upload expiry")
    const expired = (intent: UploadIntent) => this.now().getTime() >= Date.parse(`${intent.retentionUntil}T00:00:00Z`) + 86400000
    const intents = (await this.open(options.limit ?? 10)).filter(intent => expired(intent) || this.now().getTime() - Date.parse(intent.updatedAt) >= expiryMs)
    let resolved = 0
    for (const intent of intents) {
      try {
        if (await deps.isReferenced(intent)) {
          // Referenced originals follow the material deletion lifecycle; never submit expired inputs.
          if (expired(intent)) { await this.committed(intent.id); continue }
          if (deps.isParseRequired && !await deps.isParseRequired(intent)) {
            // Parse-less stored version (image): terminal commit, no material-parse task.
            await this.committed(intent.id)
            resolved++
            continue
          }
          const task = intent.parseTaskId ?? (deps.enqueueParse ? await deps.enqueueParse(intent) : undefined)
          await this.committed(intent.id, task)
          if (task) resolved++
        } else {
          await deps.store.delete(intent.objectKey)
          await this.update(intent.id, "aborted", intent.state)
          resolved++
        }
      } catch {
        await this.db.transaction(c => c.query("UPDATE equilens_material_upload_intents SET attempts=attempts+1,updated_at=$1 WHERE id=$2", [this.now().toISOString(), intent.id]))
      }
    }
    return { resolved, remaining: intents.length - resolved }
  }
}
