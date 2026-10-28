import type { Database } from "../database/connection"

/**
 * C2 private-material schema. The Lead registers these statements as the next
 * business migration after the project statements; tests apply them directly.
 */
export const statements: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS equilens_materials (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, title VARCHAR(200) NOT NULL, file_name VARCHAR(255), format VARCHAR(8) NOT NULL, source_kind VARCHAR(16) NOT NULL, source_reference VARCHAR(500) NOT NULL, processing_authorized INTEGER NOT NULL, purpose VARCHAR(500) NOT NULL, retention_until VARCHAR(10) NOT NULL, status VARCHAR(16) NOT NULL, latest_revision INTEGER NOT NULL, latest_version_id VARCHAR(36) NOT NULL, created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, FOREIGN KEY (project_id) REFERENCES equilens_projects(id))",
  "CREATE INDEX IF NOT EXISTS equilens_material_project ON equilens_materials(project_id, created_at)",
  "CREATE TABLE IF NOT EXISTS equilens_material_versions (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, material_id VARCHAR(36) NOT NULL, revision INTEGER NOT NULL, sha256 VARCHAR(64) NOT NULL, size_bytes INTEGER NOT NULL, content_type VARCHAR(128) NOT NULL, object_key VARCHAR(512) NOT NULL, file_name VARCHAR(255), created_at VARCHAR(32) NOT NULL, UNIQUE (material_id, revision), FOREIGN KEY (material_id) REFERENCES equilens_materials(id))",
  "CREATE INDEX IF NOT EXISTS equilens_material_version_digest ON equilens_material_versions(project_id, sha256)",
  "CREATE TABLE IF NOT EXISTS equilens_parse_snapshots (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, material_id VARCHAR(36) NOT NULL, version_id VARCHAR(36) NOT NULL, revision INTEGER NOT NULL, parser VARCHAR(32) NOT NULL, parser_version VARCHAR(32) NOT NULL, coverage VARCHAR(16) NOT NULL, page_count INTEGER, text_length INTEGER NOT NULL, coverage_json TEXT NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE (material_id, revision), FOREIGN KEY (material_id) REFERENCES equilens_materials(id), FOREIGN KEY (version_id) REFERENCES equilens_material_versions(id))",
  "CREATE INDEX IF NOT EXISTS equilens_snapshot_material ON equilens_parse_snapshots(material_id, revision)",
  "CREATE TABLE IF NOT EXISTS equilens_source_fragments (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, snapshot_id VARCHAR(36) NOT NULL, kind VARCHAR(16) NOT NULL, order_index INTEGER NOT NULL, page INTEGER, paragraph INTEGER, heading_path TEXT NOT NULL, table_index INTEGER, row_index INTEGER, column_index INTEGER, text TEXT NOT NULL, UNIQUE (snapshot_id, order_index), FOREIGN KEY (snapshot_id) REFERENCES equilens_parse_snapshots(id))",
  "CREATE INDEX IF NOT EXISTS equilens_fragment_snapshot ON equilens_source_fragments(snapshot_id, order_index)",
  "CREATE TABLE IF NOT EXISTS equilens_material_residue (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, object_key VARCHAR(512) NOT NULL, reason VARCHAR(200) NOT NULL, attempts INTEGER NOT NULL, created_at VARCHAR(32) NOT NULL, resolved_at VARCHAR(32), FOREIGN KEY (project_id) REFERENCES equilens_projects(id))",
  "CREATE INDEX IF NOT EXISTS equilens_material_residue_open ON equilens_material_residue(resolved_at, created_at)",
]

export async function applyMaterialSchema(database: Database): Promise<void> {
  await database.transaction(async connection => {
    for (const statement of statements) await connection.query(statement)
  })
}
