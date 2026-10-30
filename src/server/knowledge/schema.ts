/**
 * C6 publication persistence (business migration 0011, registered by the Lead
 * in src/server/database/migrations.ts).
 *
 * Frozen DDL from docs/superpowers/plans/2026-10-29-round-five-plan.md §3.
 * Provider-safe statements only: CREATE TABLE / CREATE INDEX, no CHECK
 * constraints, partial indexes, CTEs or RETURNING (spec/04 provider boundary).
 * The four publication states and every transition are enforced in
 * `publication.ts` with conditional updates asserting exactly one affected row.
 *
 * `reviewer` / `verified_at` / `review_evidence` stay nullable so draft and
 * pending versions can exist before any domain review; the publish transition
 * requires all three plus the expected digest and fails without changing state.
 */
export const statements: readonly string[] = [
  "CREATE TABLE equilens_publications (id VARCHAR(36) PRIMARY KEY, kind VARCHAR(16) NOT NULL, artifact_id VARCHAR(128) NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE(kind, artifact_id))",
  "CREATE INDEX equilens_publication_artifact ON equilens_publications(kind, artifact_id)",
  "CREATE TABLE equilens_publication_versions (id VARCHAR(36) PRIMARY KEY, publication_id VARCHAR(36) NOT NULL, version VARCHAR(64) NOT NULL, scene VARCHAR(64) NOT NULL, state VARCHAR(24) NOT NULL, sha256 VARCHAR(64) NOT NULL, payload_json TEXT NOT NULL, sources_json TEXT NOT NULL, applicability_json TEXT NOT NULL, reviewer VARCHAR(128), verified_at VARCHAR(32), review_evidence VARCHAR(500), published_at VARCHAR(32), disabled_at VARCHAR(32), disabled_reason VARCHAR(500), supersedes_id VARCHAR(36), created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE(publication_id, version))",
  "CREATE INDEX equilens_publication_version_state ON equilens_publication_versions(state, verified_at)",
]
