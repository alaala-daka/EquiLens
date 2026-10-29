/** Migration 0009. Independent of frozen material migrations. */
export const documentStatements: readonly string[] = [
  "CREATE TABLE equilens_project_document_writes (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, object_key VARCHAR(512) NOT NULL UNIQUE, provenance TEXT NOT NULL, state VARCHAR(16) NOT NULL, created_at VARCHAR(32) NOT NULL)",
  "CREATE TABLE equilens_project_documents (project_id VARCHAR(36) NOT NULL, id VARCHAR(36) PRIMARY KEY, current_version_id VARCHAR(36) NOT NULL, metadata TEXT NOT NULL)",
  "CREATE INDEX equilens_project_documents_project ON equilens_project_documents(project_id)",
  "CREATE TABLE equilens_project_document_versions (project_id VARCHAR(36) NOT NULL, id VARCHAR(36) PRIMARY KEY, document_id VARCHAR(36) NOT NULL, operation_id VARCHAR(100) NOT NULL, input_hash VARCHAR(64) NOT NULL, metadata TEXT NOT NULL, UNIQUE(document_id, operation_id), FOREIGN KEY(document_id) REFERENCES equilens_project_documents(id))",
  "CREATE INDEX equilens_project_document_versions_document ON equilens_project_document_versions(project_id, document_id)",
]
