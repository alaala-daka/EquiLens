import { createHash, randomUUID } from "node:crypto"
import type { Database, Connection, Row } from "../../database/connection"
import { StoreError } from "../../documents/repository"
import type { ReviewTask, ReviewResult, SubmitReview } from "../../../lib/contract-reviews/types"
import type { LoadedPack, Paragraph, ReviewContext } from "../../../../tools/contract-review/src/types"
import type { ReviewSkill } from "../../../../tools/contract-review/src/agent/skill"

/** 提交契约只带 scene+region；任务内部存完整上下文，供判定、展示与报告使用。 */
export type TaskInput = Omit<SubmitReview, "context"> & {
  context: ReviewContext
  title: string; revisionHash: string; pack: LoadedPack; packSha256: string; skill: ReviewSkill
  mode: "debug" | "published"; model: string; baseURL: string; maxPromptChars: number; consentAt: string
}
export type ParseSnapshot = { id: string; paragraphs: Paragraph[]; complete: boolean; textSha256: string }
export type ClaimedReview = {
  id: string; owner: string; token: string; attempt: number; callsUsed: number; maxCalls: number
  elapsedMs: number; startedAt: string; input: TaskInput; snapshot: ParseSnapshot | null; checkpoint: ReviewResult | null
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const now = () => new Date().toISOString()
const lease = () => new Date(Date.now() + 60000).toISOString()
const noAccess = () => new StoreError(404, "找不到审查任务或资料已到期。")
const lost = () => new StoreError(409, "任务执行权已变化，请重新读取状态。")
const jsonResult = (row: Row): ReviewResult | null => row.result ? parse<ReviewResult>(row.result) : null
function view(row: Row, detail = false): ReviewTask {
  return {
    id: String(row.id), documentId: String(row.document_id), revisionId: String(row.revision_id), title: String(row.title),
    state: row.state as ReviewTask["state"], stage: String(row.stage), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at), attempt: Number(row.attempt), callsUsed: Number(row.calls_used), maxCalls: Number(row.max_calls),
    progress: parse<ReviewTask["progress"]>(row.progress),
    error: row.error_code ? { code: String(row.error_code), message: String(row.error_message) } : null,
    ...(detail ? { result: jsonResult(row) } : {}),
  }
}
const schema = [
  "CREATE TABLE IF NOT EXISTS equilens_review_schema (version INTEGER PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS equilens_review_tasks (id VARCHAR(36) PRIMARY KEY,owner VARCHAR(64) NOT NULL,document_id VARCHAR(36) NOT NULL,revision_id VARCHAR(36) NOT NULL,title TEXT NOT NULL,idempotency_key VARCHAR(36) NOT NULL,request_hash VARCHAR(64) NOT NULL,input_hash VARCHAR(64) NOT NULL,input TEXT NOT NULL,state VARCHAR(16) NOT NULL,stage VARCHAR(32) NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,attempt INTEGER NOT NULL,calls_used INTEGER NOT NULL,max_calls INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,attempt_started_at TEXT,execution_token VARCHAR(36),lease_until TEXT,progress TEXT NOT NULL,parse_snapshot TEXT,result TEXT,error_code VARCHAR(64),error_message TEXT,UNIQUE(owner,idempotency_key),FOREIGN KEY(owner,document_id) REFERENCES equilens_documents(owner,id) ON DELETE CASCADE,FOREIGN KEY(owner,revision_id) REFERENCES equilens_revisions(owner,id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS equilens_review_queue ON equilens_review_tasks(state,created_at)",
  "CREATE INDEX IF NOT EXISTS equilens_review_owner ON equilens_review_tasks(owner,document_id,created_at)",
  "CREATE TABLE IF NOT EXISTS equilens_review_artifacts (task_id VARCHAR(36) NOT NULL,attempt INTEGER NOT NULL,stage VARCHAR(32) NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,attempt,stage,ordinal),FOREIGN KEY(task_id) REFERENCES equilens_review_tasks(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS equilens_review_runner (id INTEGER PRIMARY KEY,token VARCHAR(36),lease_until TEXT)",
]

export class ReviewTaskRepository {
  constructor(private readonly database: Database) {}
  async initialize() {
    await this.database.transaction(async c => {
      await c.query(schema[0])
      const { rows } = await c.query("SELECT version FROM equilens_review_schema")
      if (rows.length && (rows.length !== 1 || Number(rows[0].version) !== 1)) throw new Error("Unsupported review schema")
      for (const sql of schema.slice(1)) await c.query(sql)
      if (!rows.length) await c.query("INSERT INTO equilens_review_schema(version) VALUES (1)")
      if (!(await c.query("SELECT id FROM equilens_review_runner WHERE id=1")).rows.length) await c.query("INSERT INTO equilens_review_runner(id,token,lease_until) VALUES (1,NULL,NULL)")
    })
  }
  private async owned(c: Connection, owner: string, id: string) {
    const { rows } = await c.query("SELECT t.* FROM equilens_review_tasks t JOIN equilens_documents d ON d.owner=t.owner AND d.id=t.document_id WHERE t.owner=$1 AND t.id=$2 AND t.expires_at>$3", [owner, id, now()])
    if (!rows.length) throw noAccess()
    return rows[0]
  }
  private async executing(c: Connection, job: ClaimedReview) {
    const row = await this.owned(c, job.owner, job.id)
    if (row.state !== "running" || row.execution_token !== job.token || String(row.lease_until) <= now()) throw lost()
    return row
  }
  async readRevision(owner: string, documentId: string, revisionId: string) {
    return this.database.transaction(async c => {
      const { rows } = await c.query("SELECT r.payload,r.metadata,d.metadata AS document_metadata FROM equilens_revisions r JOIN equilens_documents d ON d.owner=r.owner AND d.id=r.document_id WHERE r.owner=$1 AND r.document_id=$2 AND r.id=$3", [owner, documentId, revisionId])
      if (!rows.length) throw noAccess()
      const bytes = Buffer.from(String(rows[0].payload), "base64")
      const revision = parse<{ hash: string }>(rows[0].metadata)
      if (createHash("sha256").update(bytes).digest("hex") !== revision.hash) throw new StoreError(500, "合同版本校验失败。")
      return { bytes, hash: revision.hash, title: parse<{ title: string }>(rows[0].document_metadata).title }
    })
  }
  list(owner: string, documentId?: string) {
    return this.database.transaction(async c => {
      const values = documentId ? [owner, now(), documentId] : [owner, now()]
      const { rows } = await c.query("SELECT t.* FROM equilens_review_tasks t JOIN equilens_documents d ON d.owner=t.owner AND d.id=t.document_id WHERE t.owner=$1 AND t.expires_at>$2" + (documentId ? " AND t.document_id=$3" : "") + " ORDER BY t.created_at DESC,t.id DESC LIMIT 50", values)
      return rows.map(row => view(row))
    })
  }
  get(owner: string, id: string) { return this.database.transaction(async c => view(await this.owned(c, owner, id), true)) }
  existing(owner: string, key: string, request: SubmitReview) {
    return this.database.transaction(async c => {
      const row = (await c.query("SELECT * FROM equilens_review_tasks WHERE owner=$1 AND idempotency_key=$2", [owner, key])).rows[0]
      if (!row) return null
      if (row.request_hash !== digest(JSON.stringify(request))) throw new StoreError(409, "此提交标识已用于不同的审查输入。")
      return view(await this.owned(c, owner, String(row.id)), true)
    })
  }
  async create(owner: string, key: string, request: SubmitReview, input: TaskInput, maxCalls: number, retentionDays: number): Promise<ReviewTask> {
    const requestHash = digest(JSON.stringify(request)), payload = JSON.stringify(input)
    const create = () => this.database.transaction(async c => {
      // 无副作用的短行锁，使跨连接的队列限额与幂等检查串行。
      await c.query("UPDATE equilens_review_runner SET id=id WHERE id=1")
      const prior = (await c.query("SELECT * FROM equilens_review_tasks WHERE owner=$1 AND idempotency_key=$2", [owner, key])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new StoreError(409, "此提交标识已用于不同的审查输入。")
        if (String(prior.expires_at) <= now()) throw noAccess()
        return view(await this.owned(c, owner, String(prior.id)), true)
      }
      const access = await c.query("SELECT id FROM equilens_revisions WHERE owner=$1 AND document_id=$2 AND id=$3", [owner, request.documentId, request.revisionId])
      if (!access.rows.length) throw noAccess()
      const total = await c.query("SELECT owner FROM equilens_review_tasks WHERE state IN ('queued','running') AND expires_at>$1", [now()])
      if (total.rows.length >= 20 || total.rows.filter(row => row.owner === owner).length >= 3) throw new StoreError(429, "审查队列已满，请稍后提交。")
      const id = randomUUID(), created = now(), expires = new Date(Date.now() + retentionDays * 86400000).toISOString()
      await c.query("INSERT INTO equilens_review_tasks(id,owner,document_id,revision_id,title,idempotency_key,request_hash,input_hash,input,state,stage,created_at,updated_at,expires_at,attempt,calls_used,max_calls,elapsed_ms,progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','queued',$10,$11,$12,0,0,$13,0,$14)",
        [id, owner, request.documentId, request.revisionId, input.title, key, requestHash, digest(payload), payload, created, created, expires, maxCalls, JSON.stringify({ readParagraphCount: 0, paragraphCount: 0, submittedRuleCount: 0 })])
      return view(await this.owned(c, owner, id), true)
    })
    try { return await create() }
    catch (failure) { if ((failure as { code?: string }).code === "23505") return create(); throw failure }
  }
  async claim(): Promise<ClaimedReview | null> {
    return this.database.transaction(async c => {
      await c.query("DELETE FROM equilens_review_tasks WHERE expires_at<=$1", [now()])
      const clock = now(), until = lease(), token = randomUUID()
      const acquired = await c.query("UPDATE equilens_review_runner SET token=$1,lease_until=$2 WHERE id=1 AND (lease_until IS NULL OR lease_until<=$3)", [token, until, clock])
      if (acquired.changes !== 1) return null
      const row = (await c.query("SELECT * FROM equilens_review_tasks WHERE state='queued' OR (state='running' AND (lease_until IS NULL OR lease_until<=$1)) ORDER BY created_at,id LIMIT 1", [clock])).rows[0]
      if (!row) { await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token]); return null }
      const elapsed = Number(row.elapsed_ms) + (row.state === "running" ? Math.max(0, Math.min(Date.now(), Date.parse(String(row.lease_until))) - Date.parse(String(row.updated_at))) : 0)
      if (Number(row.attempt) >= 3 || Number(row.calls_used) >= Number(row.max_calls) || elapsed >= 600000) {
        const code = elapsed >= 600000 ? "REVIEW_TIMEOUT" : "REVIEW_BUDGET_EXHAUSTED"
        const checkpoint = jsonResult(row)
        const partial = checkpoint?.findings.some(item => item.checkedParagraphIndexes)
        await c.query("UPDATE equilens_review_tasks SET state=$1,stage='failed',execution_token=NULL,lease_until=NULL,error_code=$2,error_message=$3,updated_at=$4 WHERE id=$5", [partial ? "partial" : "failed", code, "任务已达到累计预算或尝试次数上限。", clock, String(row.id)])
        await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
        return null
      }
      if (digest(String(row.input)) !== row.input_hash) {
        await c.query("UPDATE equilens_review_tasks SET state='failed',stage='failed',execution_token=NULL,lease_until=NULL,error_code='REVIEW_INPUT_INVALID',error_message=$1,updated_at=$2 WHERE id=$3", ["审查输入快照校验失败。", clock, String(row.id)])
        await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
        return null
      }
      const attempt = Number(row.attempt) + 1
      const claimed = await c.query("UPDATE equilens_review_tasks SET state='running',stage='parsing',attempt=$1,execution_token=$2,lease_until=$3,attempt_started_at=$4,updated_at=$5,elapsed_ms=$6,error_code=NULL,error_message=NULL WHERE id=$7 AND state=$8 AND attempt=$9 AND (lease_until IS NULL OR lease_until<=$10)", [attempt, token, until, clock, clock, Math.floor(elapsed), String(row.id), String(row.state), Number(row.attempt), clock])
      if (claimed.changes !== 1) { await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token]); return null }
      return { id: String(row.id), owner: String(row.owner), token, attempt, callsUsed: Number(row.calls_used), maxCalls: Number(row.max_calls),
        elapsedMs: Math.floor(elapsed), startedAt: clock, input: parse<TaskInput>(row.input), snapshot: row.parse_snapshot ? parse<ParseSnapshot>(row.parse_snapshot) : null, checkpoint: jsonResult(row) }
    })
  }
  async heartbeat(job: ClaimedReview, elapsedMs: number) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      const clock = now(), until = lease()
      const lock = await c.query("UPDATE equilens_review_runner SET lease_until=$1 WHERE id=1 AND token=$2 AND lease_until>$3", [until, job.token, clock])
      if (lock.changes !== 1) throw lost()
      const update = await c.query("UPDATE equilens_review_tasks SET lease_until=$1,elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND state='running'", [until, elapsedMs, clock, job.id, job.token])
      if (update.changes !== 1) throw lost()
    })
  }
  async reserve(job: ClaimedReview, callNumber: number, elapsedMs: number) {
    await this.database.transaction(async c => {
      const row = await this.executing(c, job)
      if (callNumber !== Number(row.calls_used) + 1 || callNumber > Number(row.max_calls) || elapsedMs >= 600000) throw lost()
      const update = await c.query("UPDATE equilens_review_tasks SET calls_used=$1,elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND calls_used=$6 AND state='running'", [callNumber, elapsedMs, now(), job.id, job.token, callNumber - 1])
      if (update.changes !== 1) throw lost()
    })
  }
  async checkpoint(job: ClaimedReview, stage: string, progress: ReviewTask["progress"], result: ReviewResult | null, elapsedMs: number) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      const changed = await c.query("UPDATE equilens_review_tasks SET stage=$1,progress=$2,result=COALESCE($3,result),elapsed_ms=$4,updated_at=$5 WHERE id=$6 AND execution_token=$7 AND state='running'", [stage, JSON.stringify(progress), result ? JSON.stringify(result) : null, elapsedMs, now(), job.id, job.token])
      if (changed.changes !== 1) throw lost()
    })
  }
  async snapshot(job: ClaimedReview, snapshot: ParseSnapshot) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      const changed = await c.query("UPDATE equilens_review_tasks SET parse_snapshot=$1 WHERE id=$2 AND execution_token=$3 AND parse_snapshot IS NULL AND state='running'", [JSON.stringify(snapshot), job.id, job.token])
      if (changed.changes !== 1) throw lost()
    })
  }
  async artifact(job: ClaimedReview, stage: string, ordinal: number, payload: unknown) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [job.id, job.attempt, stage, ordinal, JSON.stringify(payload), now()])
    })
  }
  async finish(job: ClaimedReview, result: ReviewResult | null, error: { code: string; message: string } | null, elapsedMs: number, retry = false) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      const row = (await c.query("SELECT calls_used,result FROM equilens_review_tasks WHERE id=$1", [job.id])).rows[0]
      const saved = result ? structuredClone(result) : jsonResult(row)
      const incomplete = saved?.findings.some(item => item.checkedParagraphIndexes) ? "partial" : "failed"
      const state = retry ? "queued" : error ? incomplete : result?.status ?? incomplete
      if (saved) {
        saved.status = state === "queued" ? "partial" : state
        if (error && !saved.errors.some(item => item.code === error.code)) saved.errors.push({ ...error, ruleIds: [] })
        await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,$2,'result',0,$3,$4)", [job.id, job.attempt, JSON.stringify(saved), now()])
      }
      const changed = await c.query("UPDATE equilens_review_tasks SET state=$1,stage=$2,result=COALESCE($3,result),error_code=$4,error_message=$5,execution_token=NULL,lease_until=NULL,elapsed_ms=$6,updated_at=$7 WHERE id=$8 AND execution_token=$9 AND state='running'", [state, retry ? "recovering" : state === "failed" ? "failed" : "completed", saved ? JSON.stringify(saved) : null, error?.code ?? null, error?.message ?? null, elapsedMs, now(), job.id, job.token])
      if (changed.changes !== 1) throw lost()
    })
  }
  async release(job: ClaimedReview) { await this.database.transaction(async c => { await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE id=1 AND token=$1", [job.token]) }) }
  async action(owner: string, id: string, action: "cancel" | "retry") {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id)
      if (action === "cancel") {
        if (["queued", "running"].includes(String(row.state))) await c.query("UPDATE equilens_review_tasks SET state='failed',stage='cancelled',execution_token=NULL,lease_until=NULL,error_code='REVIEW_CANCELLED',error_message=$1,updated_at=$2 WHERE owner=$3 AND id=$4 AND state IN ('queued','running')", ["审查已取消，不再发送新的模型请求。", now(), owner, id])
      } else {
        if (["queued", "running"].includes(String(row.state))) return view(row, true)
        if (row.state === "success" || row.error_code === "REVIEW_CANCELLED" || Number(row.attempt) >= 3 || Number(row.calls_used) >= Number(row.max_calls) || Number(row.elapsed_ms) >= 600000) throw new StoreError(409, "原任务不能继续重试；如需新分析，请重新确认后提交。")
        await c.query("UPDATE equilens_review_tasks SET state='queued',stage='queued',updated_at=$1,error_code=NULL,error_message=NULL WHERE owner=$2 AND id=$3 AND state=$4 AND attempt=$5 AND execution_token IS NULL", [now(), owner, id, String(row.state), Number(row.attempt)])
      }
      return view(await this.owned(c, owner, id), true)
    })
  }
}
