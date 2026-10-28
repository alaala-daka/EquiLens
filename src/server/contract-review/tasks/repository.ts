import { createHash, randomUUID } from "node:crypto"
import type { Database, Connection, Row } from "../../database/connection"
import { StoreError } from "../../documents/repository"
import type { DocumentSessionRepository } from "../../documents/session-repository"
import type { ReviewTask, ReviewResult, SubmitReview } from "../../../lib/contract-reviews/types"
import type { LoadedPack, Paragraph, ReviewContext } from "../../../../tools/contract-review/src/types"
import type { ReviewSkill } from "../../../../tools/contract-review/src/agent/skill"
import type { SceneCandidate } from "../../../../tools/contract-review/src/scenes"
import type { SceneBundle } from "../../../../tools/contract-review/src/bundles"
import { hasCheckedRange } from "../../../../tools/contract-review/src/findings"
import { canExportRevision } from "../../../../tools/contract-review/src/revision"
import { draftHash, revisionHash } from "../../../../tools/contract-review/src/agent/revision"
import { ReviewError } from "../../../../tools/contract-review/src/errors"
import type { documentSkill } from "../../document-agent/skills"
import { letterDraftHash, letterVerificationAllowed } from "../../document-agent/letter"
import { analysisSha, applyHumanExtraction, type HumanRevisionPayload } from "../../document-agent/revision"
import type { DocumentAnalysis } from "../../../lib/document-agent/types"
import type { DocumentReview, DocumentRevision, DocumentReviewDecision } from "../../../lib/document-agent/revisions"

/** 新任务固定候选目录；存量无目录任务沿用显式场景。 */
export type TaskInput = Omit<SubmitReview, "context"> & {
  context: ReviewContext
  title: string; revisionHash: string; pack: LoadedPack; packSha256: string
  mode: "debug" | "published"; model: string; baseURL: string; maxPromptChars: number; consentAt: string
  documentContextId: string
  sceneCandidates?: SceneCandidate[]
  revisionSource?: { taskId: string; ruleIds: string[] }
  revisionPrimary?: ReviewResult
  letterSources?: { payment?: { taskId: string; result: ReviewResult }; evidence?: { taskId: string; result: ReviewResult } }
  sceneBundles?: SceneBundle[]
  auditEffort?: "default" | "low"
  primaryStrategy?: "prepared-v1"; primaryEffort?: "default" | "low"; revisionEffort?: "default" | "low"; maxKnownTokens?: number
  revisionStrategy?: "prepared-v1"
  auditStrategy?: "prepared-v1"
  repairStrategy?: "one-round-v1"
} & ({ workflow: "document-agent-v1"; skill: ReturnType<typeof documentSkill> }
  | { workflow?: "multi-agent-v1" | "multi-agent-revision-v1" | "revision-only-v1"; skill: ReviewSkill })
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
const hasPartial = (result: ReviewResult | null) => Boolean(result?.findings.some(hasCheckedRange) || result?.documentAnalysis?.extraction)
function view(row: Row, detail = false): ReviewTask {
  const input = parse<TaskInput>(row.input)
  return {
    id: String(row.id), documentId: String(row.document_id), revisionId: String(row.revision_id), title: String(row.title),
    kind: input.task ?? "contract-review", asOf: input.asOf, maxKnownTokens: input.maxKnownTokens,
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
  constructor(private readonly database: Database, private readonly sessions: DocumentSessionRepository) {}
  private async guard(c: Connection, owner: string, contextId: string, action: "read" | "review" = "read") {
    const record = await this.sessions.guardIn(c, owner, action)
    if (!contextId) throw new StoreError(400, "缺少会话上下文。", "SESSION_CONTEXT_REQUIRED")
    if (record.contextId !== contextId) throw new StoreError(409, "会话已变更，请重新载入。", "SESSION_CHANGED")
    return record
  }
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
  private async owned(c: Connection, owner: string, id: string, contextId: string, action: "read" | "review" = "read") {
    await this.guard(c, owner, contextId, action)
    const { rows } = await c.query("SELECT t.* FROM equilens_review_tasks t JOIN equilens_documents d ON d.owner=t.owner AND d.id=t.document_id WHERE t.owner=$1 AND t.id=$2 AND t.expires_at>$3", [owner, id, now()])
    if (!rows.length) throw noAccess()
    return rows[0]
  }
  private async executing(c: Connection, job: ClaimedReview) {
    const row = await this.owned(c, job.owner, job.id, job.input.documentContextId, "review")
    if (row.state !== "running" || row.execution_token !== job.token || String(row.lease_until) <= now()) throw lost()
    return row
  }
  async readRevision(owner: string, documentId: string, revisionId: string, contextId: string) {
    return this.database.transaction(async c => {
      await this.guard(c, owner, contextId, "review")
      const { rows } = await c.query("SELECT r.payload,r.metadata,d.metadata AS document_metadata FROM equilens_revisions r JOIN equilens_documents d ON d.owner=r.owner AND d.id=r.document_id WHERE r.owner=$1 AND r.document_id=$2 AND r.id=$3", [owner, documentId, revisionId])
      if (!rows.length) throw noAccess()
      const bytes = Buffer.from(String(rows[0].payload), "base64")
      const revision = parse<{ hash: string }>(rows[0].metadata)
      if (createHash("sha256").update(bytes).digest("hex") !== revision.hash) throw new StoreError(500, "合同版本校验失败。")
      return { bytes, hash: revision.hash, title: parse<{ title: string }>(rows[0].document_metadata).title }
    })
  }
  list(owner: string, documentId: string | undefined, contextId: string) {
    return this.database.transaction(async c => {
      await this.guard(c, owner, contextId)
      const values = documentId ? [owner, now(), documentId] : [owner, now()]
      const { rows } = await c.query("SELECT t.* FROM equilens_review_tasks t JOIN equilens_documents d ON d.owner=t.owner AND d.id=t.document_id WHERE t.owner=$1 AND t.expires_at>$2" + (documentId ? " AND t.document_id=$3" : "") + " ORDER BY t.created_at DESC,t.id DESC LIMIT 50", values)
      return rows.map(row => view(row))
    })
  }
  get(owner: string, id: string, contextId: string) { return this.database.transaction(async c => view(await this.owned(c, owner, id, contextId), true)) }
  existing(owner: string, key: string, request: SubmitReview, contextId: string) {
    return this.database.transaction(async c => {
      await this.guard(c, owner, contextId, "review")
      const row = (await c.query("SELECT * FROM equilens_review_tasks WHERE owner=$1 AND idempotency_key=$2", [owner, key])).rows[0]
      if (!row) return null
      if (row.request_hash !== digest(JSON.stringify(request))) throw new StoreError(409, "此提交标识已用于不同的审查输入。")
      return view(await this.owned(c, owner, String(row.id), contextId, "review"), true)
    })
  }
  async create(owner: string, key: string, request: SubmitReview, input: TaskInput, maxCalls: number, retentionDays: number, notAfter?: string): Promise<ReviewTask> {
    const requestHash = digest(JSON.stringify(request)), payload = JSON.stringify(input)
    const create = () => this.database.transaction(async c => {
      const sourceSession = await this.guard(c, owner, input.documentContextId, "review")
      // 无副作用的短行锁，使跨连接的队列限额与幂等检查串行。
      await c.query("UPDATE equilens_review_runner SET id=id WHERE id=1")
      const prior = (await c.query("SELECT * FROM equilens_review_tasks WHERE owner=$1 AND idempotency_key=$2", [owner, key])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new StoreError(409, "此提交标识已用于不同的审查输入。")
        if (String(prior.expires_at) <= now()) throw noAccess()
        return view(await this.owned(c, owner, String(prior.id), input.documentContextId, "review"), true)
      }
      const access = await c.query("SELECT id FROM equilens_revisions WHERE owner=$1 AND document_id=$2 AND id=$3", [owner, request.documentId, request.revisionId])
      if (!access.rows.length) throw noAccess()
      const total = await c.query("SELECT owner FROM equilens_review_tasks WHERE state IN ('queued','running') AND expires_at>$1", [now()])
      if (total.rows.length >= 20 || total.rows.filter(row => row.owner === owner).length >= 3) throw new StoreError(429, "审查队列已满，请稍后提交。")
      if (!sourceSession.expiresAt) throw noAccess()
      const id = randomUUID(), created = now(), expires = new Date(Math.min(Date.now() + retentionDays * 86400000, Date.parse(sourceSession.expiresAt), notAfter ? Date.parse(notAfter) : Infinity)).toISOString()
      await c.query("INSERT INTO equilens_review_tasks(id,owner,document_id,revision_id,title,idempotency_key,request_hash,input_hash,input,state,stage,created_at,updated_at,expires_at,attempt,calls_used,max_calls,elapsed_ms,progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','queued',$10,$11,$12,0,0,$13,0,$14)",
        [id, owner, request.documentId, request.revisionId, input.title, key, requestHash, digest(payload), payload, created, created, expires, maxCalls, JSON.stringify({ readParagraphCount: 0, paragraphCount: 0, submittedRuleCount: 0 })])
      return view(await this.owned(c, owner, id, input.documentContextId, "review"), true)
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
        const partial = hasPartial(checkpoint)
        await c.query("UPDATE equilens_review_tasks SET state=$1,stage='failed',execution_token=NULL,lease_until=NULL,error_code=$2,error_message=$3,updated_at=$4 WHERE id=$5", [partial ? "partial" : "failed", code, "任务已达到累计预算或尝试次数上限。", clock, String(row.id)])
        await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
        return null
      }
      if (digest(String(row.input)) !== row.input_hash) {
        await c.query("UPDATE equilens_review_tasks SET state='failed',stage='failed',execution_token=NULL,lease_until=NULL,error_code='REVIEW_INPUT_INVALID',error_message=$1,updated_at=$2 WHERE id=$3", ["审查输入快照校验失败。", clock, String(row.id)])
        await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
        return null
      }
      const input = parse<TaskInput>(row.input)
      try { await this.guard(c, String(row.owner), input.documentContextId, "review") }
      catch (failure) {
        if (!(failure instanceof StoreError)) throw failure
        await c.query("UPDATE equilens_review_tasks SET state='failed',stage='failed',execution_token=NULL,lease_until=NULL,error_code=$1,error_message=$2,updated_at=$3 WHERE id=$4", [failure.code ?? "REVIEW_INPUT_INVALID", failure.message, clock, String(row.id)])
        await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token])
        return null
      }
      const attempt = Number(row.attempt) + 1
      const claimed = await c.query("UPDATE equilens_review_tasks SET state='running',stage='parsing',attempt=$1,execution_token=$2,lease_until=$3,attempt_started_at=$4,updated_at=$5,elapsed_ms=$6,error_code=NULL,error_message=NULL WHERE id=$7 AND state=$8 AND attempt=$9 AND (lease_until IS NULL OR lease_until<=$10)", [attempt, token, until, clock, clock, Math.floor(elapsed), String(row.id), String(row.state), Number(row.attempt), clock])
      if (claimed.changes !== 1) { await c.query("UPDATE equilens_review_runner SET token=NULL,lease_until=NULL WHERE token=$1", [token]); return null }
      return { id: String(row.id), owner: String(row.owner), token, attempt, callsUsed: Number(row.calls_used), maxCalls: Number(row.max_calls),
        elapsedMs: Math.floor(elapsed), startedAt: clock, input, snapshot: row.parse_snapshot ? parse<ParseSnapshot>(row.parse_snapshot) : null, checkpoint: jsonResult(row) }
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
      // The immutable exchange ledger survives a crash between response persistence and checkpointing.
      const tokenLimit = parse<TaskInput>(row.input).maxKnownTokens
      if (tokenLimit !== undefined) {
        const exchanges = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND stage='model-exchange'", [job.id])).rows
        let knownTokens = 0
        for (const exchange of exchanges) {
          const usage = parse<{ response?: { usage?: { total_tokens?: unknown } } }>(exchange.payload).response?.usage?.total_tokens
          if (typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0) knownTokens += usage
        }
        if (knownTokens >= tokenLimit) throw new ReviewError("REVIEW_TOKEN_BUDGET_EXHAUSTED")
      }
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
  async sourceReview(owner: string, id: string, contextId: string) {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId, "review")
      const result = jsonResult(row)
      if (!["success", "partial"].includes(String(row.state)) || !result) throw new StoreError(409, "原审查尚未完成，不能生成修订稿。")
      return { input: parse<TaskInput>(row.input), result, expiresAt: String(row.expires_at) }
    })
  }
  /** 文档 Agent 结果的人工修订版本；版本 0 为机器结果，不写入 artifact。 */
  async documentRevisions(owner: string, id: string, contextId: string): Promise<{ machine: DocumentRevision; revisions: DocumentRevision[] }> {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId)
      const result = jsonResult(row), machine = result?.documentAnalysis
      if (!result || !machine) throw new StoreError(409, "该任务不是文档 Agent 结果。")
      const rows = (await c.query("SELECT stage,ordinal,payload,created_at FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=0 AND stage IN ('human-revision','review') ORDER BY ordinal", [id])).rows
      const reviews: DocumentReview[] = rows.filter(item => item.stage === "review").map(item => parse<DocumentReview>(item.payload))
      const latestReview = (versionId: string) => reviews.filter(item => item.versionId === versionId).at(-1) ?? null
      const revisions = rows.filter(item => item.stage === "human-revision")
        .map(item => parse<HumanRevisionPayload>(item.payload))
        .map(payload => ({ versionId: payload.versionId, versionNumber: payload.versionNumber, baseVersionId: payload.baseVersionId,
          isMachine: false, createdAt: payload.createdAt, createdBy: payload.createdBy, changeReason: payload.changeReason,
          sha256: payload.sha256, review: latestReview(payload.versionId), analysis: payload.analysis }))
      const machineRevision: DocumentRevision = { versionId: "machine", versionNumber: 0, isMachine: true, createdAt: result.createdAt,
        createdBy: "机器整理", sha256: analysisSha(machine), review: latestReview("machine"), analysis: machine }
      return { machine: machineRevision, revisions }
    })
  }
  async saveDocumentRevision(owner: string, id: string, contextId: string, input: { baseVersionId: string; extraction: unknown; changeReason: string; createdBy: string }): Promise<DocumentRevision> {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId, "review")
      const result = jsonResult(row), machine = result?.documentAnalysis
      const snapshot = row.parse_snapshot ? parse<ParseSnapshot>(row.parse_snapshot) : null
      if (!result || !machine || !snapshot) throw new StoreError(409, "该任务不是可修订的文档 Agent 结果。")
      const rows = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=0 AND stage='human-revision' ORDER BY ordinal", [id])).rows
      const latest = rows.length ? parse<HumanRevisionPayload>(rows.at(-1)!.payload) : null
      const baseVersionId = latest?.versionId ?? "machine"
      if (input.baseVersionId !== baseVersionId) throw new StoreError(409, "结果已有新版本，请重新载入后再修订。")
      let analysis: DocumentAnalysis
      try { analysis = applyHumanExtraction(machine, input.extraction, snapshot.paragraphs, machine.cutoff) }
      catch (failure) { if (failure instanceof ReviewError) throw new StoreError(422, failure.message); throw failure }
      const versionNumber = rows.length + 1, versionId = randomUUID(), createdAt = now()
      const payload: HumanRevisionPayload = { versionId, versionNumber, baseVersionId, analysis, changeReason: input.changeReason, createdBy: input.createdBy, createdAt, sha256: "" }
      payload.sha256 = analysisSha(analysis)
      await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,0,'human-revision',$2,$3,$4)",
        [id, versionNumber, JSON.stringify(payload), createdAt])
      return { versionId, versionNumber, baseVersionId, isMachine: false, createdAt, createdBy: input.createdBy, changeReason: input.changeReason, sha256: payload.sha256, review: null, analysis }
    })
  }
  async reviewDocumentRevision(owner: string, id: string, contextId: string, versionId: string, input: { decision: DocumentReviewDecision; reviewer: string; note: string }): Promise<DocumentReview> {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId, "review")
      const result = jsonResult(row)
      if (!result?.documentAnalysis) throw new StoreError(409, "该任务不是文档 Agent 结果。")
      const human = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=0 AND stage='human-revision'", [id])).rows
      if (versionId !== "machine" && !human.some(item => parse<HumanRevisionPayload>(item.payload).versionId === versionId)) throw new StoreError(404, "找不到该结果版本。")
      const reviews = (await c.query("SELECT ordinal FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=0 AND stage='review' ORDER BY ordinal", [id])).rows
      const review: DocumentReview = { reviewId: randomUUID(), versionId, decision: input.decision, reviewer: input.reviewer, note: input.note, createdAt: now() }
      await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,0,'review',$2,$3,$4)",
        [id, reviews.length + 1, JSON.stringify(review), review.createdAt])
      return review
    })
  }
  async saveRevisionExport(job: ClaimedReview, input: ReviewResult, bytes: Buffer, elapsedMs: number): Promise<ReviewResult> {
    const result = structuredClone(input)
    const draft = result.collaboration?.revision, audit = result.collaboration?.revisionAudit
    const revisionWorkflow = job.input.workflow === "multi-agent-revision-v1" || job.input.workflow === "revision-only-v1"
    if (!revisionWorkflow || !job.input.generateRevision || result.collaboration?.version !== job.input.workflow ||
      !draft || !result.collaboration?.primary || !canExportRevision(draft, audit) || draft.sha256 !== draftHash(draft) ||
      draft.primarySha256 !== revisionHash(result.collaboration.primary) || result.input.documentVersionId !== job.input.revisionId ||
      result.input.parseSnapshotId !== job.snapshot?.id || result.input.textSha256 !== job.snapshot?.textSha256 ||
      !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs >= 600000 || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new StoreError(409, "修订稿未完成核对或版本不匹配。")
    return this.database.transaction(async c => {
      await this.executing(c, job)
      const existing = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=$2 AND stage='revision-docx' AND ordinal=0", [job.id, job.attempt])).rows[0]
      const payload = existing ? parse<{ bytes: string; sha256: string; draftSha256: string; renderVersion: string }>(existing.payload)
        : { bytes: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), draftSha256: draft.sha256, renderVersion: "contract-revision-docx-v1" }
      if (payload.draftSha256 !== draft.sha256 || createHash("sha256").update(Buffer.from(payload.bytes, "base64")).digest("hex") !== payload.sha256) throw new StoreError(409, "历史修订文件不匹配，禁止覆盖。")
      if (!existing) await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,$2,'revision-docx',0,$3,$4)", [job.id, job.attempt, JSON.stringify(payload), now()])
      const title = result.documentTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[ .]+$/g, "").slice(0, 70) || "合同"
      draft.export = { sha256: payload.sha256, draftSha256: draft.sha256, renderVersion: payload.renderVersion, attempt: job.attempt, filename: title + "-AI修订建议稿.docx" }
      const changed = await c.query("UPDATE equilens_review_tasks SET result=$1,stage='validating',elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND state='running'", [JSON.stringify(result), elapsedMs, now(), job.id, job.token])
      if (changed.changes !== 1) throw lost()
      return result
    })
  }
  async revisionExport(owner: string, id: string, contextId: string) {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId)
      const result = jsonResult(row), draft = result?.collaboration?.revision, audit = result?.collaboration?.revisionAudit
      if (!["success", "partial"].includes(String(row.state)) || !draft?.export || !canExportRevision(draft, audit) || draft.sha256 !== draftHash(draft) ||
        !result?.collaboration?.primary || draft.primarySha256 !== revisionHash(result.collaboration.primary)) throw new StoreError(409, "修订稿尚未生成，或仍有待处理问题。")
      const saved = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=$2 AND stage='revision-docx' AND ordinal=0", [id, draft.export.attempt])).rows[0]
      if (!saved) throw new StoreError(404, "找不到已保存的修订文件。")
      const payload = parse<{ bytes: string; sha256: string; draftSha256: string; renderVersion: string }>(saved.payload)
      const bytes = Buffer.from(payload.bytes, "base64")
      if (payload.sha256 !== draft.export.sha256 || payload.draftSha256 !== draft.sha256 || payload.renderVersion !== draft.export.renderVersion ||
        createHash("sha256").update(bytes).digest("hex") !== payload.sha256) throw new StoreError(500, "修订文件校验失败。")
      return { bytes, filename: draft.export.filename, sha256: payload.sha256 }
    })
  }
  async saveLetterExport(job: ClaimedReview, input: ReviewResult, bytes: Buffer, elapsedMs: number): Promise<ReviewResult> {
    const result = structuredClone(input), analysis = result.documentAnalysis, letter = analysis?.letter
    if (job.input.workflow !== "document-agent-v1" || job.input.task !== "collection-letter" || !analysis || !letter || !letterVerificationAllowed(analysis) || !letter.auditPassed ||
      result.input.documentVersionId !== job.input.revisionId || result.input.parseSnapshotId !== job.snapshot?.id || result.input.textSha256 !== job.snapshot?.textSha256 ||
      !bytes.length || bytes.length > 1024 * 1024 || elapsedMs >= 600000) throw new StoreError(409, "催款函草稿未完成校验或版本不匹配。")
    return this.database.transaction(async c => {
      await this.executing(c, job)
      const existing = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND stage='letter-docx' ORDER BY attempt DESC LIMIT 1", [job.id])).rows[0]
      const payload = existing ? parse<{ bytes: string; sha256: string; draftSha256: string; renderVersion: string; attempt: number }>(existing.payload)
        : { bytes: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), draftSha256: letterDraftHash(letter), renderVersion: "collection-letter-docx-v1", attempt: job.attempt }
      if (payload.draftSha256 !== letterDraftHash(letter) || createHash("sha256").update(Buffer.from(payload.bytes, "base64")).digest("hex") !== payload.sha256) throw new StoreError(409, "已保存催款函不匹配，禁止覆盖。")
      if (!existing) {
        await c.query("INSERT INTO equilens_review_artifacts(task_id,attempt,stage,ordinal,payload,created_at) VALUES ($1,$2,'letter-docx',0,$3,$4)", [job.id, job.attempt, JSON.stringify(payload), now()])
      }
      letter.export = { sha256: payload.sha256, draftSha256: payload.draftSha256, renderVersion: payload.renderVersion, attempt: payload.attempt, filename: "催款函-AI草稿.docx" }
      const changed = await c.query("UPDATE equilens_review_tasks SET result=$1,stage='validating',elapsed_ms=$2,updated_at=$3 WHERE id=$4 AND execution_token=$5 AND state='running'", [JSON.stringify(result), elapsedMs, now(), job.id, job.token])
      if (changed.changes !== 1) throw lost()
      return result
    })
  }
  async letterExport(owner: string, id: string, contextId: string) {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId), result = jsonResult(row), analysis = result?.documentAnalysis, letter = analysis?.letter
      if (!["success", "partial"].includes(String(row.state)) || !analysis || !letter?.export || !letter.auditPassed || !letterVerificationAllowed(analysis) || letterDraftHash(letter) !== letter.export.draftSha256) throw new StoreError(409, "催款函草稿尚未完成校验。")
      const saved = (await c.query("SELECT payload FROM equilens_review_artifacts WHERE task_id=$1 AND attempt=$2 AND stage='letter-docx' AND ordinal=0", [id, letter.export.attempt])).rows[0]
      if (!saved) throw new StoreError(409, "催款函文件尚未保存。")
      const payload = parse<{ bytes: string; sha256: string; draftSha256: string; renderVersion: string }>(saved.payload), bytes = Buffer.from(payload.bytes, "base64")
      if (createHash("sha256").update(bytes).digest("hex") !== payload.sha256 || payload.sha256 !== letter.export.sha256 || payload.draftSha256 !== letter.export.draftSha256 || payload.renderVersion !== letter.export.renderVersion) throw new StoreError(500, "催款函文件校验失败。")
      return { bytes, sha256: payload.sha256, filename: letter.export.filename }
    })
  }
  async finish(job: ClaimedReview, result: ReviewResult | null, error: { code: string; message: string } | null, elapsedMs: number, retry = false) {
    await this.database.transaction(async c => {
      await this.executing(c, job)
      const row = (await c.query("SELECT calls_used,result FROM equilens_review_tasks WHERE id=$1", [job.id])).rows[0]
      const saved = result ? structuredClone(result) : jsonResult(row)
      const incomplete = hasPartial(saved) ? "partial" : "failed"
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
  async action(owner: string, id: string, action: "cancel" | "retry", contextId: string) {
    return this.database.transaction(async c => {
      const row = await this.owned(c, owner, id, contextId, action === "retry" ? "review" : "read")
      if (action === "cancel") {
        if (["queued", "running"].includes(String(row.state))) await c.query("UPDATE equilens_review_tasks SET state='failed',stage='cancelled',execution_token=NULL,lease_until=NULL,error_code='REVIEW_CANCELLED',error_message=$1,updated_at=$2 WHERE owner=$3 AND id=$4 AND state IN ('queued','running')", ["审查已取消，不再发送新的模型请求。", now(), owner, id])
      } else {
        if (["queued", "running"].includes(String(row.state))) return view(row, true)
        const analysis = jsonResult(row)?.documentAnalysis
        if (analysis?.audit.complete && (analysis.task !== "collection-letter" || analysis.letter?.export)) throw new StoreError(409, "当前资料已完成机器核对；补充材料后请明确提交新任务。")
        if (row.state === "success" || ["REVIEW_CANCELLED", "REVIEW_TOKEN_BUDGET_EXHAUSTED"].includes(String(row.error_code)) || Number(row.attempt) >= 3 || Number(row.calls_used) >= Number(row.max_calls) || Number(row.elapsed_ms) >= 600000) throw new StoreError(409, "原任务不能继续重试；如需新分析，请重新确认后提交。")
        await c.query("UPDATE equilens_review_tasks SET state='queued',stage='queued',updated_at=$1,error_code=NULL,error_message=NULL WHERE owner=$2 AND id=$3 AND state=$4 AND attempt=$5 AND execution_token IS NULL", [now(), owner, id, String(row.state), Number(row.attempt)])
      }
      return view(await this.owned(c, owner, id, contextId), true)
    })
  }
}
