import type { Database } from "../database/connection"
import {
  businessMigrations,
  migrateBusiness,
  type BusinessMigration,
} from "../database/migrations"
import { statements as knowledgeStatements } from "./schema"

/**
 * C6 migration 0011 wiring helper.
 *
 * The Lead owns `src/server/database/migrations.ts` and registers the frozen
 * 0011 entry there during round-five integration. Until that registration
 * lands, the private maintenance CLI and this package's tests must still be
 * able to build the schema; both use this helper, which appends the identical
 * frozen `{id:"0011", statements}` only when 0011 is not registered yet.
 *
 * When the Lead registers 0011, the registered object is used unchanged (so the
 * frozen checksum is the single authority) — the helper never overrides it.
 * If the registered 0011 content differed from `schema.ts`, the migration
 * history check fails closed on the next startup instead of silently drifting.
 */
export function knowledgeBusinessMigrations(): readonly BusinessMigration[] {
  if (businessMigrations.some(migration => migration.id === "0011")) return businessMigrations
  return [...businessMigrations, { id: "0011", statements: knowledgeStatements }]
}

/** Explicit database initialization for the private CLI/tests; never runs on import. */
export async function applyKnowledgeMigrations(database: Database): Promise<void> {
  await migrateBusiness(database, knowledgeBusinessMigrations())
}
