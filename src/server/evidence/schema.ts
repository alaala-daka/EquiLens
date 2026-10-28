/** 证据模块表结构。编号由整合方统一登记；本文件不修改全局迁移注册表。 */
export const evidenceSchema = [
  `CREATE TABLE IF NOT EXISTS equilens_evidence_items (
    id VARCHAR(36) PRIMARY KEY,
    item_id VARCHAR(36) NOT NULL,
    version_id VARCHAR(36) NOT NULL UNIQUE,
    project_id VARCHAR(64) NOT NULL,
    contract_id VARCHAR(64),
    supersedes_version_id VARCHAR(36),
    sha256 VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS equilens_evidence_item_project ON equilens_evidence_items(project_id, item_id, created_at)",
  `CREATE TABLE IF NOT EXISTS equilens_evidence_reports (
    id VARCHAR(36) PRIMARY KEY,
    revision_id VARCHAR(36) NOT NULL UNIQUE,
    report_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    contract_id VARCHAR(64),
    base_revision_id VARCHAR(36),
    status VARCHAR(16) NOT NULL,
    review_status VARCHAR(16) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS equilens_evidence_report_project ON equilens_evidence_reports(project_id, report_id, created_at)",
] as const
