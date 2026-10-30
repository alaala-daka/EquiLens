/**
 * C4 verification persistence (business migration 0010, registered by the Lead).
 *
 * Provider-safe DDL only: CREATE TABLE / CREATE INDEX, no CHECK constraints,
 * partial indexes, CTEs or RETURNING (spec/04 双 provider 边界). Enum membership
 * and state transitions are enforced in the service layer, and every conditional
 * update asserts exactly one affected row.
 *
 * Field rows are insert-only history: an OCR run or a human correction inserts a
 * new row (`previous_id`, `revision + 1`) and then conditionally supersedes the
 * previous current row, so re-runs and corrections preserve the original values
 * (spec 01 §6.1/§8.3) and multiple certificate subjects can coexist per version.
 */
export const statements: readonly string[] = [
  "CREATE TABLE equilens_ocr_runs (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, material_id VARCHAR(36) NOT NULL, version_id VARCHAR(36) NOT NULL, certificate_kind VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, provider VARCHAR(64), provider_version VARCHAR(64), request_id VARCHAR(128), calls_used INTEGER NOT NULL, usage_json TEXT, image_json TEXT, error_code VARCHAR(64), created_by VARCHAR(36) NOT NULL, started_at VARCHAR(32) NOT NULL, finished_at VARCHAR(32))",
  "CREATE INDEX equilens_ocr_run_material ON equilens_ocr_runs(project_id, material_id)",
  "CREATE INDEX equilens_ocr_run_state ON equilens_ocr_runs(state)",
  "CREATE TABLE equilens_verification_fields (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, material_id VARCHAR(36) NOT NULL, version_id VARCHAR(36) NOT NULL, subject_key VARCHAR(64) NOT NULL, field_key VARCHAR(64) NOT NULL, label VARCHAR(128) NOT NULL, value_text TEXT NOT NULL, normalized_value TEXT NOT NULL, origin VARCHAR(16) NOT NULL, source_snapshot_id VARCHAR(36), source_fragment_id VARCHAR(64), ocr_run_id VARCHAR(36), confidence INTEGER, box_json TEXT, revision INTEGER NOT NULL, previous_id VARCHAR(36), superseded_at VARCHAR(32), reason VARCHAR(500), created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL)",
  "CREATE INDEX equilens_verification_field_version ON equilens_verification_fields(project_id, version_id, field_key)",
  "CREATE INDEX equilens_verification_field_current ON equilens_verification_fields(project_id, version_id, superseded_at)",
  "CREATE TABLE equilens_verification_records (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, requirement_set_version_id VARCHAR(36) NOT NULL, requirement_id VARCHAR(64) NOT NULL, subject VARCHAR(200) NOT NULL, certificate_no VARCHAR(128) NOT NULL, source VARCHAR(500) NOT NULL, queried_at VARCHAR(32) NOT NULL, query_conditions_json TEXT NOT NULL, conclusion VARCHAR(16) NOT NULL, proof_material_version_id VARCHAR(36) NOT NULL, sha256 VARCHAR(64) NOT NULL, created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL)",
  "CREATE INDEX equilens_verification_record_set ON equilens_verification_records(project_id, requirement_set_version_id)",
]
