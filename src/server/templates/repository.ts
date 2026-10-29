import { randomUUID } from "node:crypto"
import type { Connection, Database, Row } from "../database/connection"
import { BusinessError } from "../projects/errors"
import type { DraftingKind } from "./catalog"
import type { DraftingInputPayload } from "../drafting/payload"

/**
 * Immutable drafting-input version storage (business migration 0012).
 *
 * A drafting input is one project-private proposed-input series; each save
 * appends a new immutable version and conditionally advances the input's
 * `current_version_id`. `UNIQUE(project_id, operation_id)` provides idempotency;
 * the same operation id with a different request hash is a CONFLICT, never an
 * overwrite. The service layer computes payload digests and enforces the
 * template/catalog rules; this repository only persists and reads rows.
 */
export type DraftingInputRecord = {
  id: string
  projectId: string
  kind: DraftingKind
  currentVersionId: string
  createdAt: string
}

export type DraftingInputVersionRecord = {
  id: string
  inputId: string
  projectId: string
  kind: DraftingKind
  version: number
  baseVersionId: string
  operationId: string
  requestHash: string
  sha256: string
  payload: DraftingInputPayload
  createdBy: string
  createdAt: string
}

export type AppendDraftingInputVersion = {
  projectId: string
  inputId?: string
  expectedBaseVersionId: string
  kind: DraftingKind
  operationId: string
  requestHash: string
  sha256: string
  payload: DraftingInputPayload
  createdBy: string
}

const uniqueViolation = (failure: unknown) => {
  const value = failure as { code?: string; errcode?: number }
  return value.code === "23505" || value.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY"
    || value.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || value.errcode === 1555 || value.errcode === 2067
}

const parsePayload = (raw: unknown): DraftingInputPayload => JSON.parse(String(raw)) as DraftingInputPayload

function inputRecord(row: Row): DraftingInputRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as DraftingKind,
    currentVersionId: String(row.current_version_id),
    createdAt: String(row.created_at),
  }
}

function versionRecord(row: Row): DraftingInputVersionRecord {
  return {
    id: String(row.id),
    inputId: String(row.input_id),
    projectId: String(row.project_id),
    kind: String(row.kind) as DraftingKind,
    version: Number(row.version),
    baseVersionId: String(row.base_version_id),
    operationId: String(row.operation_id),
    requestHash: String(row.request_hash),
    sha256: String(row.sha256),
    payload: parsePayload(row.payload_json),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  }
}

const VERSION_COLUMNS = "id,input_id,project_id,kind,version,base_version_id,operation_id,request_hash,sha256,payload_json,created_by,created_at"

export class DraftingInputRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  private clock(): string { return this.now().toISOString() }

  async findInput(projectId: string, inputId: string): Promise<DraftingInputRecord | null> {
    return this.database.transaction(async connection => {
      const row = (await connection.query("SELECT * FROM equilens_drafting_inputs WHERE project_id=$1 AND id=$2", [projectId, inputId])).rows[0]
      return row ? inputRecord(row) : null
    })
  }

  async findVersionByOperation(projectId: string, operationId: string): Promise<DraftingInputVersionRecord | null> {
    return this.database.transaction(async connection => {
      const row = (await connection.query(`SELECT ${VERSION_COLUMNS} FROM equilens_drafting_input_versions WHERE project_id=$1 AND operation_id=$2`, [projectId, operationId])).rows[0]
      return row ? versionRecord(row) : null
    })
  }

  async current(projectId: string, inputId: string): Promise<DraftingInputVersionRecord | null> {
    return this.version(projectId, inputId)
  }

  async version(projectId: string, inputId: string, versionId?: string): Promise<DraftingInputVersionRecord | null> {
    return this.database.transaction(async connection => {
      const input = (await connection.query("SELECT * FROM equilens_drafting_inputs WHERE project_id=$1 AND id=$2", [projectId, inputId])).rows[0]
      if (!input) return null
      const row = (await connection.query(
        `SELECT ${VERSION_COLUMNS} FROM equilens_drafting_input_versions WHERE project_id=$1 AND input_id=$2 AND id=$3`,
        [projectId, inputId, versionId ?? String(input.current_version_id)],
      )).rows[0]
      return row ? versionRecord(row) : null
    })
  }

  async versions(projectId: string, inputId: string): Promise<DraftingInputVersionRecord[]> {
    return this.database.transaction(async connection => {
      const rows = (await connection.query(
        `SELECT ${VERSION_COLUMNS} FROM equilens_drafting_input_versions WHERE project_id=$1 AND input_id=$2 ORDER BY version DESC`,
        [projectId, inputId],
      )).rows
      return rows.map(versionRecord)
    })
  }

  /** Project input summaries with their current version (newest first). */
  async list(projectId: string, kind?: DraftingKind): Promise<Array<{ input: DraftingInputRecord; current: DraftingInputVersionRecord }>> {
    return this.database.transaction(async connection => {
      const values: string[] = [projectId]
      let sql = "SELECT id,project_id,kind,current_version_id,created_at FROM equilens_drafting_inputs WHERE project_id=$1"
      if (kind) { sql += " AND kind=$2"; values.push(kind) }
      sql += " ORDER BY created_at DESC, id DESC"
      const inputs = (await connection.query(sql, values)).rows.map(inputRecord)
      const summaries: Array<{ input: DraftingInputRecord; current: DraftingInputVersionRecord }> = []
      for (const input of inputs) {
        const row = (await connection.query(`SELECT ${VERSION_COLUMNS} FROM equilens_drafting_input_versions WHERE project_id=$1 AND input_id=$2 AND id=$3`, [projectId, input.id, input.currentVersionId])).rows[0]
        if (row) summaries.push({ input, current: versionRecord(row) })
      }
      return summaries
    })
  }

  /**
   * Append one immutable version. Existing input: the caller must pin the
   * current version; a stale base is CONFLICT. New input: create the series and
   * its version 1 atomically. Duplicate operation ids surface as a unique
   * violation for the service layer to resolve idempotently.
   */
  async append(input: AppendDraftingInputVersion): Promise<DraftingInputVersionRecord> {
    return this.database.transaction(async connection => {
      const clock = this.clock()
      let inputId = input.inputId
      let nextVersion = 1
      if (inputId) {
        const current = (await connection.query("SELECT * FROM equilens_drafting_inputs WHERE project_id=$1 AND id=$2", [input.projectId, inputId])).rows[0]
        if (!current) throw new BusinessError("NOT_FOUND", "找不到该拟约定输入。")
        if (String(current.kind) !== input.kind) throw new BusinessError("CONFLICT", "拟约定输入的文书类型已变化，请重新读取。")
        if (String(current.current_version_id) !== input.expectedBaseVersionId) throw new BusinessError("CONFLICT", "拟约定输入已有新版本，请重新读取后再保存。")
        const latest = (await connection.query(
          "SELECT version FROM equilens_drafting_input_versions WHERE project_id=$1 AND input_id=$2 ORDER BY version DESC LIMIT 1",
          [input.projectId, inputId],
        )).rows[0]
        nextVersion = Number(latest?.version ?? 0) + 1
      }
      const versionId = this.createId()
      if (!inputId) {
        inputId = this.createId()
        await connection.query(
          "INSERT INTO equilens_drafting_inputs(id,project_id,kind,current_version_id,created_at) VALUES($1,$2,$3,$4,$5)",
          [inputId, input.projectId, input.kind, versionId, clock],
        )
      }
      await connection.query(
        "INSERT INTO equilens_drafting_input_versions(id,input_id,project_id,kind,version,base_version_id,operation_id,request_hash,sha256,payload_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [versionId, inputId, input.projectId, input.kind, nextVersion, input.expectedBaseVersionId, input.operationId, input.requestHash, input.sha256, JSON.stringify(input.payload), input.createdBy, clock],
      )
      if (input.inputId) {
        const advanced = await connection.query(
          "UPDATE equilens_drafting_inputs SET current_version_id=$1 WHERE project_id=$2 AND id=$3 AND current_version_id=$4",
          [versionId, input.projectId, input.inputId, input.expectedBaseVersionId],
        )
        if (advanced.changes !== 1) throw new BusinessError("CONFLICT", "拟约定输入已有新版本，请重新读取后再保存。")
      }
      return versionRecord({
        id: versionId, input_id: inputId, project_id: input.projectId, kind: input.kind, version: nextVersion,
        base_version_id: input.expectedBaseVersionId, operation_id: input.operationId, request_hash: input.requestHash,
        sha256: input.sha256, payload_json: JSON.stringify(input.payload), created_by: input.createdBy, created_at: clock,
      })
    })
  }

  /** Resolve a concurrent duplicate operation id: same request hash returns the persisted version, else CONFLICT. */
  async resolveDuplicate(projectId: string, operationId: string, requestHash: string): Promise<DraftingInputVersionRecord | null> {
    const existing = await this.findVersionByOperation(projectId, operationId)
    if (!existing) return null
    if (existing.requestHash !== requestHash) throw new BusinessError("CONFLICT", "该提交标识已用于不同的拟约定输入。")
    return existing
  }

  static isUniqueViolation(failure: unknown): boolean {
    return uniqueViolation(failure)
  }

  // Kept for service-level conditional assertions in tests.
  async rawVersion(connection: Connection, projectId: string, operationId: string): Promise<Row | undefined> {
    return (await connection.query("SELECT * FROM equilens_drafting_input_versions WHERE project_id=$1 AND operation_id=$2", [projectId, operationId])).rows[0]
  }
}
