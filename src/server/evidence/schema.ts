/**
 * 证据模块的历史报告表结构（匿名文档 Agent 增量/领域层遗留）。
 *
 * 第八轮起项目主线的证据项表由迁移 0015 建立，证据报告与催款函作为
 * `equilens_results` 的成果版本保存；本表不再由项目主线写入。
 * 编号由整合方统一登记；本文件不修改全局迁移注册表。
 */
export const evidenceReportSchema = [
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

/** 兼容旧导入名：历史测试与引导代码仍以 evidenceSchema 引用报告表。 */
export const evidenceSchema = evidenceReportSchema
