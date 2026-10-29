import { randomUUID } from "node:crypto"
import type { Connection, Database, Row } from "../database/connection"
import { BusinessError } from "../projects/errors"
import { UploadIntents } from "./upload-intents"
import type {
  CoverageStatus, MaterialFormat, MaterialRecord, MaterialSourceKind, MaterialSummary, MaterialVersionRecord,
  ParseCoverage, ParseSnapshotRecord, SourceFragmentRecord,
} from "./types"

const sourceKinds: readonly MaterialSourceKind[] = ["synthetic", "authorized"]
const formats: readonly MaterialFormat[] = ["docx", "pdf"]
const coverageStatuses: readonly CoverageStatus[] = ["available", "partial", "failed"]
const statuses = ["active", "deleted"] as const

const materialRecord = (row: Row): MaterialRecord => ({
  id: String(row.id),
  projectId: String(row.project_id),
  title: String(row.title),
  fileName: row.file_name === null ? null : String(row.file_name),
  format: storedFormat(row.format),
  sourceKind: storedSource(row.source_kind),
  sourceReference: String(row.source_reference),
  processingAuthorized: Number(row.processing_authorized) === 1,
  purpose: String(row.purpose),
  retentionUntil: String(row.retention_until),
  status: storedStatus(row.status),
  latestRevision: Number(row.latest_revision),
  latestVersionId: String(row.latest_version_id),
  createdBy: String(row.created_by),
  createdAt: String(row.created_at),
})

const versionRecord = (row: Row): MaterialVersionRecord => ({
  id: String(row.id),
  projectId: String(row.project_id),
  materialId: String(row.material_id),
  revision: Number(row.revision),
  sha256: String(row.sha256),
  size: Number(row.size_bytes),
  contentType: String(row.content_type),
  objectKey: String(row.object_key),
  fileName: row.file_name === null ? null : String(row.file_name),
  createdAt: String(row.created_at),
})

const snapshotRecord = (row: Row): ParseSnapshotRecord => ({
  id: String(row.id),
  projectId: String(row.project_id),
  materialId: String(row.material_id),
  versionId: String(row.version_id),
  revision: Number(row.revision),
  parser: String(row.parser),
  parserVersion: String(row.parser_version),
  coverage: storedCoverage(row.coverage_json),
  createdAt: String(row.created_at),
})

const fragmentRecord = (row: Row): SourceFragmentRecord => ({
  id: String(row.id),
  projectId: String(row.project_id),
  snapshotId: String(row.snapshot_id),
  kind: row.kind === "table" ? "table" : "paragraph",
  order: Number(row.order_index),
  page: row.page === null ? null : Number(row.page),
  paragraph: row.paragraph === null ? null : Number(row.paragraph),
  headingPath: storedHeadingPath(row.heading_path),
  tableIndex: row.table_index === null ? null : Number(row.table_index),
  row: row.row_index === null ? null : Number(row.row_index),
  column: row.column_index === null ? null : Number(row.column_index),
  text: String(row.text),
})

function storedFormat(value: unknown): MaterialFormat {
  if (typeof value !== "string" || !formats.includes(value as MaterialFormat)) throw new Error("Invalid stored material format")
  return value as MaterialFormat
}
function storedSource(value: unknown): MaterialSourceKind {
  if (typeof value !== "string" || !sourceKinds.includes(value as MaterialSourceKind)) throw new Error("Invalid stored material source")
  return value as MaterialSourceKind
}
function storedStatus(value: unknown): MaterialRecord["status"] {
  if (typeof value !== "string" || !statuses.includes(value as typeof statuses[number])) throw new Error("Invalid stored material status")
  return value as MaterialRecord["status"]
}
function storedCoverage(value: unknown): ParseCoverage {
  let parsed: unknown
  try { parsed = JSON.parse(String(value)) } catch { throw new Error("Invalid stored parse coverage") }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid stored parse coverage")
  const coverage = parsed as ParseCoverage
  if (!coverageStatuses.includes(coverage.status)) throw new Error("Invalid stored parse coverage")
  if (!Array.isArray(coverage.findings) || coverage.findings.some(finding => !finding || typeof finding.code !== "string" || typeof finding.location !== "string")) throw new Error("Invalid stored parse coverage")
  if (typeof coverage.textLength !== "number" || (coverage.pageCount !== null && typeof coverage.pageCount !== "number")) throw new Error("Invalid stored parse coverage")
  return coverage
}
function storedHeadingPath(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value))
    if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) throw new Error()
    return parsed as string[]
  } catch {
    throw new Error("Invalid stored heading path")
  }
}

export type NewMaterial = {
  material: MaterialRecord
  version: MaterialVersionRecord
  snapshot?: ParseSnapshotRecord
  fragments?: SourceFragmentRecord[]
}

/**
 * Insert-only material/parse storage. New parses create new snapshots; old
 * snapshots and fragments are never updated or deleted by this repository.
 */
export class MaterialRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  private timestamp() {
    return this.now().toISOString()
  }

  uploadIntents(): UploadIntents { return new UploadIntents(this.database, this.now) }

  async parseTaskId(projectId: string, materialId: string): Promise<string | null> {
    const result = await this.database.transaction(c => c.query("SELECT parse_task_id FROM equilens_materials WHERE project_id=$1 AND id=$2", [projectId, materialId]))
    return result.rows[0]?.parse_task_id == null ? null : String(result.rows[0].parse_task_id)
  }

  async linkTask(projectId: string, materialId: string, taskId: string): Promise<void> {
    await this.database.transaction(c => c.query("UPDATE equilens_materials SET parse_task_id=$1 WHERE project_id=$2 AND id=$3", [taskId, projectId, materialId]))
  }

  async objectReferenced(objectKey: string): Promise<boolean> {
    const result = await this.database.transaction(c => c.query("SELECT id FROM equilens_material_versions WHERE object_key=$1 LIMIT 1", [objectKey]))
    return result.rows.length > 0
  }

  newId(): string {
    return this.createId()
  }

  async create(input: NewMaterial): Promise<void> {
    await this.database.transaction(async connection => {
      const { material, version, snapshot } = input
      await connection.query(
        "INSERT INTO equilens_materials(id,project_id,title,file_name,format,source_kind,source_reference,processing_authorized,purpose,retention_until,status,latest_revision,latest_version_id,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [material.id, material.projectId, material.title, material.fileName, material.format, material.sourceKind, material.sourceReference, 1, material.purpose, material.retentionUntil, material.status, material.latestRevision, material.latestVersionId, material.createdBy, material.createdAt],
      )
      await connection.query(
        "INSERT INTO equilens_material_versions(id,project_id,material_id,revision,sha256,size_bytes,content_type,object_key,file_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [version.id, version.projectId, version.materialId, version.revision, version.sha256, version.size, version.contentType, version.objectKey, version.fileName, version.createdAt],
      )
      if (snapshot) await this.insertSnapshot(connection, snapshot, input.fragments ?? [])
    })
  }

  /** Conditional revision bump keeps a concurrent reparse from overwriting a newer snapshot. */
  async addSnapshot(snapshot: ParseSnapshotRecord, fragments: SourceFragmentRecord[], expectedRevision: number, job?: import("../tasks/repository").ClaimedTask): Promise<void> {
    await this.database.transaction(async connection => {
      if (job) {
        const claimed = await connection.query("UPDATE equilens_tasks SET stage=stage WHERE id=$1 AND project_id=$2 AND state='running' AND execution_token=$3 AND attempt=$4 AND lease_until>$5", [job.id, snapshot.projectId, job.token, job.attempt, this.timestamp()])
        if (claimed.changes !== 1) throw new BusinessError("CONFLICT", "任务执行权已变化。")
      }
      const updated = await connection.query(
        "UPDATE equilens_materials SET latest_revision=$1 WHERE id=$2 AND project_id=$3 AND status='active' AND latest_revision=$4",
        [snapshot.revision, snapshot.materialId, snapshot.projectId, expectedRevision],
      )
      if (updated.changes !== 1) throw new BusinessError("CONFLICT", "材料版本已变化，请刷新后重试。")
      await this.insertSnapshot(connection, snapshot, fragments)
    })
  }

  private async insertSnapshot(connection: Connection, snapshot: ParseSnapshotRecord, fragments: SourceFragmentRecord[]): Promise<void> {
    await connection.query(
      "INSERT INTO equilens_parse_snapshots(id,project_id,material_id,version_id,revision,parser,parser_version,coverage,page_count,text_length,coverage_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [snapshot.id, snapshot.projectId, snapshot.materialId, snapshot.versionId, snapshot.revision, snapshot.parser, snapshot.parserVersion, snapshot.coverage.status, snapshot.coverage.pageCount, snapshot.coverage.textLength, JSON.stringify(snapshot.coverage), snapshot.createdAt],
    )
    for (const fragment of fragments) {
      await connection.query(
        "INSERT INTO equilens_source_fragments(id,project_id,snapshot_id,kind,order_index,page,paragraph,heading_path,table_index,row_index,column_index,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [fragment.id, fragment.projectId, fragment.snapshotId, fragment.kind, fragment.order, fragment.page, fragment.paragraph, JSON.stringify(fragment.headingPath), fragment.tableIndex, fragment.row, fragment.column, fragment.text],
      )
    }
  }

  async findMaterial(projectId: string, materialId: string): Promise<MaterialRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_materials WHERE project_id=$1 AND id=$2", [projectId, materialId]))
    return rows.length ? materialRecord(rows[0]) : null
  }

  async latestVersion(projectId: string, materialId: string): Promise<MaterialVersionRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT v.* FROM equilens_material_versions v JOIN equilens_materials m ON m.latest_version_id=v.id WHERE v.project_id=$1 AND v.material_id=$2", [projectId, materialId]))
    return rows.length ? versionRecord(rows[0]) : null
  }

  async versionById(projectId: string, versionId: string): Promise<MaterialVersionRecord | null> {
    const { rows } = await this.database.transaction(c => c.query("SELECT * FROM equilens_material_versions WHERE project_id=$1 AND id=$2", [projectId, versionId]))
    return rows.length ? versionRecord(rows[0]) : null
  }
  async findVersion(projectId: string, materialId: string, versionId: string): Promise<MaterialVersionRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_material_versions WHERE project_id=$1 AND material_id=$2 AND id=$3", [projectId, materialId, versionId]))
    return rows.length ? versionRecord(rows[0]) : null
  }

  async findByDigest(projectId: string, sha256: string): Promise<{ material: MaterialRecord; version: MaterialVersionRecord } | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT m.*, v.id AS version_id, v.revision AS version_revision, v.created_at AS version_created_at, v.file_name AS version_file_name FROM equilens_material_versions v JOIN equilens_materials m ON m.id=v.material_id WHERE v.project_id=$1 AND v.sha256=$2 AND m.status='active' ORDER BY v.created_at, v.id LIMIT 1", [projectId, sha256]))
    if (!rows.length) return null
    const row = rows[0]
    return {
      material: materialRecord(row),
      version: {
        id: String(row.version_id),
        projectId: String(row.project_id),
        materialId: String(row.id),
        revision: Number(row.version_revision),
        sha256: String(row.sha256),
        size: Number(row.size_bytes),
        contentType: String(row.content_type),
        objectKey: String(row.object_key),
        fileName: row.version_file_name === null ? null : String(row.version_file_name),
        createdAt: String(row.version_created_at),
      },
    }
  }

  async latestSnapshot(projectId: string, materialId: string): Promise<ParseSnapshotRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT s.* FROM equilens_parse_snapshots s JOIN equilens_materials m ON m.id=s.material_id AND m.latest_revision=s.revision WHERE s.project_id=$1 AND s.material_id=$2", [projectId, materialId]))
    return rows.length ? snapshotRecord(rows[0]) : null
  }

  async findSnapshot(projectId: string, snapshotId: string): Promise<ParseSnapshotRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_parse_snapshots WHERE project_id=$1 AND id=$2", [projectId, snapshotId]))
    return rows.length ? snapshotRecord(rows[0]) : null
  }

  async fragments(snapshotId: string): Promise<SourceFragmentRecord[]> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_source_fragments WHERE snapshot_id=$1 ORDER BY order_index", [snapshotId]))
    return rows.map(fragmentRecord)
  }

  async findFragment(projectId: string, snapshotId: string, fragmentId: string): Promise<SourceFragmentRecord | null> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_source_fragments WHERE project_id=$1 AND snapshot_id=$2 AND id=$3", [projectId, snapshotId, fragmentId]))
    return rows.length ? fragmentRecord(rows[0]) : null
  }

  async listMaterials(projectId: string): Promise<MaterialSummary[]> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT m.*, v.id AS version_id, v.sha256, v.size_bytes, s.id AS snapshot_id, s.coverage_json, t.state AS parse_state FROM equilens_materials m JOIN equilens_material_versions v ON v.id=m.latest_version_id LEFT JOIN equilens_parse_snapshots s ON s.material_id=m.id AND s.revision=m.latest_revision LEFT JOIN equilens_tasks t ON t.id=m.parse_task_id AND t.project_id=m.project_id WHERE m.project_id=$1 AND m.status='active' ORDER BY m.created_at, m.id", [projectId]))
    return rows.map(row => ({
      id: String(row.id),
      title: String(row.title),
      fileName: row.file_name === null ? null : String(row.file_name),
      format: storedFormat(row.format),
      size: Number(row.size_bytes),
      sha256: String(row.sha256),
      versionId: String(row.version_id),
      createdAt: String(row.created_at),
      parseTaskId: row.parse_task_id == null ? null : String(row.parse_task_id),
      parseState: row.parse_state == null ? null : String(row.parse_state),
      snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
      coverage: row.coverage_json === null || row.coverage_json === undefined ? null : storedCoverage(row.coverage_json),
    }))
  }

  async recordResidue(projectId: string, objectKey: string, reason: string): Promise<void> {
    await this.database.transaction(connection =>
      connection.query("INSERT INTO equilens_material_residue(id,project_id,object_key,reason,attempts,created_at,resolved_at) VALUES($1,$2,$3,$4,0,$5,NULL)", [this.createId(), projectId, objectKey, reason.slice(0, 200), this.timestamp()]))
  }

  async openResidues(limit: number): Promise<{ id: string; projectId: string; objectKey: string; attempts: number }[]> {
    const { rows } = await this.database.transaction(connection =>
      connection.query("SELECT id,project_id,object_key,attempts FROM equilens_material_residue WHERE resolved_at IS NULL ORDER BY created_at, id LIMIT $1", [limit]))
    return rows.map(row => ({ id: String(row.id), projectId: String(row.project_id), objectKey: String(row.object_key), attempts: Number(row.attempts) }))
  }

  async resolveResidue(id: string): Promise<void> {
    await this.database.transaction(connection =>
      connection.query("UPDATE equilens_material_residue SET resolved_at=$1 WHERE id=$2 AND resolved_at IS NULL", [this.timestamp(), id]))
  }

  async recordResidueFailure(id: string): Promise<void> {
    await this.database.transaction(connection =>
      connection.query("UPDATE equilens_material_residue SET attempts=attempts+1 WHERE id=$1 AND resolved_at IS NULL", [id]))
  }
}
