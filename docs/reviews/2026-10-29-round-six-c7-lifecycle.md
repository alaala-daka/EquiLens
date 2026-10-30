# Round Six — C7 project lifecycle, object reclamation, deletion replay and retention (implementation evidence)

- Owner: Agent E (C7), task `task-19` (R6-C7).
- Branch: `alaaladaka/round6/lifecycle`; HEAD when work started: `ed7b585` ("docs: freeze round-six lifecycle and platform contracts"). Working tree changes only; **no `git add`/`commit`**; HEAD unchanged.
- Contract: `docs/superpowers/plans/2026-10-29-round-six-plan.md` §2/§3/§4.1/§4.2/§5 C7/§7; independent plan review `.superpowers/round6/plan-review.md` (BLOCK-1..6 fixes implemented); owning specs `spec/01-product.md` §9/§10.4–10.5 and `spec/04-database-deployment.md` (0013/runtime/env/private maintenance). `.superpowers/round4/research-c7-a5.md` was treated as untrusted input; its ordering/reuse claims were re-verified against the current code.
- Scope actually written: new `src/server/projects/{lifecycle,lifecycle-schema,reclamation,deletion-journal,retention}.ts` + 5 test files; modified `src/server/projects/{repository,service,handlers,access,authorization}.ts` and the two existing project test setups; `src/app/api/projects/[id]/deletion/route.ts`; `scripts/project-lifecycle.mts`; minimal generic extraction in `src/server/documents/retention-journal.ts`; this evidence file. No `spec/**`, `migrations*`, `instrumentation.ts`, `projects/runtime.ts`, `package.json`, `.env.example`, `README`, `docs/deployment.md`, `docs/operations.md` edits (the latter two are A5's in-progress changes, not mine).

## 1. Delivered behaviour

### 1.1 Migration 0013 (frozen DDL exported; Lead registers)

`src/server/projects/lifecycle-schema.ts` exports the exact plan §3 statements (`equilens_project_deletions` + `equilens_project_reclamations`, two indexes, `UNIQUE(project_id)`/`UNIQUE(object_key)`, nullable `retention_until/completed_at/cleared_at`, no FK/CHECK). Lead integration action: register `{ id: "0013", statements }` in `src/server/database/migrations.ts` by importing from this file (do not retype the DDL; checksum is permanent), then add empty-DB/repeat/checksum/rollback/0001–0012-unchanged assertions in `migrations.test.ts`. Until registration lands, `applyProjectLifecycleSchema()` probes the actual table and applies the identical frozen statements for tests/CLI, so the same tests keep passing before and after integration.

### 1.2 DELETE takeover (same transaction, idempotent, reconcile)

`ProjectRepository.delete(projectId, actor, reason)` now performs in one transaction: row lock → conditional `status='active'→'deleted'` + `deleted_at/revision` (audited `project.delete`) → insert the `requested` deletion record (`intent_id`, reason, requestedBy, requestedAt, retentionUntil) exactly once. Repeated/concurrent DELETE returns the existing record (idempotent); a legacy `status='deleted'` row without a record is reconciled by creating the record (never re-activated). The HTTP path (`ProjectService.remove` via handlers) then appends the durable private journal intent; if the journal is unavailable the project stays access-revoked (`requested`) and DELETE returns 503, while `GET /deletion` remains readable. Records are permanent tombstones; project rows are never physically deleted.

### 1.3 Per-request retention revocation (derived, not sweep-dependent)

`src/server/projects/retention.ts` freezes the clock rule: `retention_until` is an Asia/Shanghai calendar date; an authorized project is expired from `start of (retention_until + 1 day) at UTC+08:00` (inclusive retention day). `ProjectRepository.findActive/findMember/listFor/activeIn` derive this on **every** call (injected repository clock); expired authorized projects are treated as absent (uniform FORBIDDEN/NOT_FOUND, excluded from lists, denied to background `authorizeTaskExecution`) without waiting for the sweep. Synthetic projects never auto-expire (archive not delivered; explicit delete required) and remain accessible/deletable. Hourly sweep only expires/cleans; it is not the access guard.

### 1.4 Private deletion journal (one intent per file)

`src/server/projects/deletion-journal.ts` implements the frozen `ProjectDeletionIntent` (`version:1, id, projectId, reason, requestedBy, requestedAt, retentionUntil`), one `<intent id>.json` file, strict exact-field validation (field set/version/uuid/ISO time/date/reason), whole-batch conflict rejection (duplicate id, per-project differing content), directory 700/file 600 outside `public/`, temp file + file `fsync` + atomic `rename` + per-level directory `fsync` (via the generic helpers extracted from `documents/retention-journal.ts`; anonymous journal semantics unchanged, its tests still pass). A crash-left temp file is ignored; unknown files/JSON/fields reject readiness. The journal only contains metadata — no project name, material text, object keys or credentials. Windows cannot fsync directory handles: the shared helper treats only that platform error (EPERM/EISDIR/EINVAL/ENOTSUP) as a documented platform gap, so local Windows runs still write the intent while recording the weaker barrier; **non-platform faults still fail the append closed** (no object is deleted; the project stays revoked/retried). Linux real per-level fsync remains a production requirement and is not verified on this Windows host.

### 1.5 Reclamation and ordered row deletion

`src/server/projects/reclamation.ts`:
- Journal intent is ensured **before** any object deletion; then conditional `requested|failed → reclaiming`; failure keeps `failed` + attempts/lastError (access never returns to active).
- Object inventory is rebuilt from project-scoped rows only (material versions, upload intents, residue, project-document writes, project-document version metadata, result exports — paged; no store list API). Every key must match `projects/<projectId>/…`; a foreign/cross-project key aborts the attempt instead of deleting. Reclamations are inserted under `UNIQUE(object_key)` and deleted per key with attempts; unconfigured store fails closed (no row deletion/completion); a persistent object failure leaves rows intact and retries next sweep; retries resume cleared work.
- After all objects are cleared, `PROJECT_SCOPED_TABLES` are deleted in the frozen child→parent order (C4 OCR/fields/records, C5 drafting input/versions, results/exports/reviews/dependencies, tasks/budget, project documents, materials/fragments/snapshots, members/audit, plus B-line runtime facts/payments/evidence tables) and the record becomes `reclaimed` with `completed_at/cleared_at` in the **same transaction**. Runtime-created B-line tables are deleted only when present; missing tables are recorded as skipped (B line not wired). Provider-safe existence probing avoids PostgreSQL/GaussDB transaction-abort semantics.
- The guard test bootstraps facts/payments/evidence schemas, enumerates every `sqlite_master` table with a `project_id` column, and fails if any table is outside `PROJECT_SCOPED_TABLES` ∪ deletion/reclamation tombstones (a synthetic new `project_id` table fails the guard).

### 1.6 Offline restore replay (never revive, idempotent)

`replayProjectDeletionIntents(database, journal, intents, deps)` validates the whole journal and DB-record agreement **before** any change. Per project: restored row present → conditional `status='deleted'` revocation + record insert/validate, then object inventory rebuilt from restored rows and cleaned (missing objects count as cleared, leftovers retried); row absent → tombstone record only (`reclaimed`), no project is created/reactivated. A project already deleted with a `reclaimed` record is an idempotent no-op; a revived active row is re-deleted and re-cleaned. Conflicting journal/DB record content rejects the replay without changing state. Runtime startup runs the same replay plus record-less reconcile plus one bounded reclaim pass **before** lifecycle readiness (replay-before-visibility).

### 1.7 Lifecycle runtime and readiness gate

`src/server/projects/lifecycle.ts` provides `createProjectLifecycleRuntime({initialize,sweep,schedule,intervalMs?})` (testable) and the production `startProjectLifecycleRuntime()`/`projectLifecycleReady()`/`stopProjectLifecycleRuntime()`/`requireProjectLifecycleReady()`:
- `start()` returns immediately (health/server not blocked); readiness resolves only after journal validation/replay + record-less reconcile + one bounded reclaim attempt. Init failure keeps not-ready (business 503) and rejects `projectLifecycleReady()`; a missing resolver-equivalent gate fails closed. Single-flight sweep, timer `unref`, `nudge()` coalesced, `stop()` waits for the in-flight short sweep/transaction; sweep failures are contained and do not revoke readiness.
- Gate wiring: `access.ts` passes `requireProjectLifecycleReady` into `createProjectAuthorization`/`createTaskExecutionAuthorization`/`ProjectService`; production `requireProjectAccess`, task execution authorization, project list/create/DELETE/GET-deletion return 503 until ready. Tests inject gates directly (default no-op keeps existing direct-injection tests unchanged).
- Frozen env helpers: `PROJECT_DELETION_JOURNAL_DIR` (explicit for GaussDB, SQLite default `<db dir>/project-deletion-journal`), `PROJECT_RECLAIM_BATCH` (default 10, 1–100), `PROJECT_LIFECYCLE_INTERVAL_MS` (default 3600000, min 60000) strict validation fail-closed; no test-only env clock in production (tests inject clocks/repository now).

### 1.8 `GET /api/projects/[id]/deletion`

`src/app/api/projects/[id]/deletion/route.ts` → handlers `deletion.GET` → `ProjectService.deletionState`: revalidates the session, returns only `{state, requestedAt, attempts, completedAt, clearedAt}` with `Cache-Control: private, no-store` (never project content). Allowed for the recorded `requested_by` and current superadmins forever; other current project admins only while their membership rows remain (after ordered row deletion they get 404); everyone else uniform 404. Readable while the lifecycle is starting? No — 503 until ready (frozen readiness contract).

### 1.9 Private maintenance CLI

`scripts/project-lifecycle.mts`: `inspect` (redacted metadata/counts only), `reclaim [--project ID] [--apply]` (dry-run lists candidates; apply retries object/row reclamation), `replay [--journal DIR] [--apply --offline-restored-database]` (validate-only by default; apply requires the stop-the-world offline confirmation). Explicit database initialisation (`.env.local`, explicit provider, absolute existing SQLite path), object store selected fail-closed (dev file store only with explicit dev opt-in, production unavailable), exit codes 0/1/2 (2 = usage/config), generic safe error messages, no HTTP write route. Lead/A5 integration: add `scripts/generated/project-lifecycle.mjs` to `scripts/build-retention-tools.mjs` and a `package.json` entry, and copy the operational text into `docs/operations.md` (A5 owns that file).

## 2. Test and command evidence (actual runs)

| # | Command | Exit | Result |
| - | - | - | - |
| 1 | `pnpm exec tsx --test src/server/projects/*.test.ts src/server/documents/retention-cleanup.test.ts src/server/documents/retention-maintenance.test.ts` | 0 | **69 tests / 67 pass / 2 skipped / 0 fail** (2 skipped = Linux-only real file+directory fsync tests; Windows directory fsync is the documented platform gap in the shared helper, logical barriers covered with injected filesystems) |
| 2 | `pnpm exec tsx --test src/server/projects/deletion-journal.test.ts` | 0 | 8 tests: 7 pass, 1 Linux-only skipped (exact-field validation, batch conflicts, one-file append/idempotence, bad files/JSON, traversal/public rejection, non-platform directory-fsync failure fail-closed + retry, temp-file crash recovery) |
| 3 | `pnpm exec tsx --test src/server/projects/lifecycle.test.ts` | 0 | 9 pass (per-request retention denial before sweep + injected clock boundary; synthetic exemption; sweep candidate selection; same-transaction delete record/audit/journal; idempotent repeat; non-admin/unknown refusals; record-less reconcile; journal-failure keeps revoked; retention sweep takeover; journal factory) |
| 4 | `pnpm exec tsx --test src/server/projects/lifecycle-runtime.test.ts` | 0 | 6 pass (non-blocking start/not-ready 503; failed init 503/rejected readiness; replay-before-visibility + material-repair ordering; single-flight/coalesced nudge/stop waits; contained sweep failure; env boundaries fail closed) |
| 5 | `pnpm exec tsx --test src/server/projects/reclamation.test.ts` | 0 | 12 pass (full object+row cleanup with FK order; other project + anonymous tables untouched; inventory from rows only; sqlite_master guard incl. bootstrapped B-line schemas and synthetic extra-table failure; persistent partial delete failure → failed/revoked then retry reclaimed; unconfigured store fail-closed; journal failure deletes nothing; redacted inspect; old-backup replay revokes/purges; deletion-after backup replay no-op; conflicting record rejects before change; row-absent tombstone-only; objects-cleared-but-row-delete-failed stays revoked and retries) |
| 6 | `pnpm exec tsx --test src/server/projects/deletion-http.test.ts` | 0 | 4 pass (requester/superadmin read after deletion, other admins only while member rows exist, viewer/non-member/unauthenticated refusal; repeated DELETE idempotent + superadmin finish; journal failure 503 with observable requested status; readiness gate 503 for DELETE/GET-deletion/list with no state change) |
| 7 | Existing project regression (`service.test.ts`/`http.test.ts`/`execution.test.ts` inside run #1) | 0 | all pass (setups now apply 0013 via the probe helper) |
| 8 | `pnpm exec tsc --noEmit` (full repo with parallel C5/C4-UI/A5 work present) | **0** | no type errors |
| 9 | `git diff --check` | 0 | no whitespace errors |

### CLI end-to-end (temporary SQLite + synthetic project under ignored `.superpowers/round6/`)

Seed script `.superpowers/round6/c7-cli-seed.mts` created a temporary DB with one synthetic project and a `requested` deletion record (never the repo `data/` database; local `.env.local` exists but explicit `DATABASE_PROVIDER/SQLITE_PATH` were passed and took precedence for the path):

| Step | Command | Exit | Observed |
| - | - | - | - |
| inspect | `pnpm exec tsx scripts/project-lifecycle.mts inspect` | 0 | redacted JSON: one `requested` record, attempts 0, pendingReclaimProjects 1, recordlessDeleted 0; no project name/object keys |
| reclaim dry-run | `... reclaim` | 0 | candidate list `{projectId,state:"requested"}, applied:false` |
| reclaim apply (Windows) | `... reclaim --apply --project <id>` | 0 | `{"projectId":"…","state":"reclaimed","attempts":1,"deletedObjects":0,"skippedTables":["equilens_fact_versions","equilens_payment_ledger_revisions","equilens_evidence_items","equilens_evidence_reports"]}` — Windows directory fsync is the documented platform gap (the intent file is written with file fsync+rename; only directory fsync is skipped), so reclamation completes locally, matching A5's drill. Linux real-fsync remeasurement remains a platform item |
| replay validate-only | `... replay --journal <empty dir>` | 0 | `{"projects":0,"applied":false,"existingRecords":1}` |
| replay apply no-op | `... replay --journal <empty dir> --apply --offline-restored-database` | 0 | all counters 0, `applied:true` (empty journal is a valid no-op) |
| replay apply w/o offline flag | `... replay --journal <empty dir> --apply` | 2 | usage error (offline-restored confirmation required) |
| invalid command | `... bogus` | 2 | usage error |
| missing explicit provider | (masked by the repo's local `.env.local`, which supplies `DATABASE_PROVIDER=sqlite`) | 0 | not cleanly demonstrable in this working copy; the explicit-provider branch throws a usage error in code and was exercised by the reclaim/replay argument paths |

## 3. Requirement traceability (plan §3/§4/§5 C7)

| Requirement | Implementation | Tests |
| - | - | - |
| 0013 exactly as frozen, no FK/CHECK, conditional updates changes===1 | `lifecycle-schema.ts`, reclamation transitions, repository delete | #1/#3/#5, tsc |
| DELETE: same transaction status+record, idempotent, record-less reconcile | `repository.delete`, `service.remove`, `reclaimRecordlessDeletedProjects` | #3/#6 |
| Journal unavailable ⇒ no object deletion, stay requested/revoked | `reclaimProject` journal barrier | #3 journal-failure, #5 |
| Per-request retention revocation in findActive/findMember/listFor/authorizeTaskExecution + list exclusion, injected clock | `retention.ts`, repository, authorization | #3, #7 |
| Synthetic projects never auto-swept; explicit delete works | `retention.projectDataExpired`, sweep selection | #3 |
| Journal contract one intent/file, strict fields, temp+fsync+rename+per-level dir fsync, duplicate/conflict rejection | `deletion-journal.ts`, generic extraction | #2 |
| Object inventory from project rows (no store list), per-object attempts, no foreign-project deletion, unconfigured store fail-closed | `reclamation.ts projectObjectKeys/store` | #5 |
| Ordered `PROJECT_SCOPED_TABLES` incl. C4/C5 and runtime B-line tables present-only; guard bootstraps schemas + sqlite_master whitelist | `lifecycle-schema.ts`, `deleteProjectRows`/reclaim, guard test | #5 |
| Offline replay: old backup not revived, deletion-after backup no-op, bad/conflict journal rejected, row-absent tombstone-only | `replayProjectDeletionIntents` | #5 |
| Runtime initialize/ready/replay-before-visibility/non-blocking healthy start/background chain after ready/single-flight/unref/stop waits | `lifecycle.ts` | #4 |
| Readiness gate at requireProjectAccess/authorizeTaskExecution/list/create/DELETE/GET-deletion (503 before ready) | `access.ts`, `authorization.ts`, `service.ts` | #4/#6 |
| CLI inspect/reclaim/replay explicit DB init/offline flag/redacted/exit codes | `scripts/project-lifecycle.mts` | CLI e2e above |
| GET /deletion frozen role matrix, no content, no-store | handlers/service/route | #6 |
| C4/C5 delete-seeded coverage (OCR/fields/records, drafting inputs/versions, result exports etc.) | reclamation fixture seeds all tables | #5 |

## 4. Not run / limitations / handoffs

1. **0013 is not registered yet** (Lead owns `src/server/database/migrations.ts`). The runtime/CLI/tests use the probe helper applying identical frozen statements; Lead must register 0013 (and freeze its checksum) in the integration commit. If the DDL is retyped differently, the migration-history check fails closed.
2. **Production wiring not done by C7** (Lead owns `src/instrumentation.ts`/`projects/runtime.ts`): start lifecycle after anonymous retention **without awaiting** initialization; the background chain must start material orphan repair only after `projectLifecycleReady()` resolves, then review/verification/knowledge, then the task runner. `package.json`/`build-retention-tools` entries for the CLI are Lead-owned; operational text must be handed to A5 for `docs/operations.md`.
3. **Real GaussDB, real OBS/private bucket, Linux file/directory fsync, non-root container, remote backup/restore and 4h/24h recovery targets are unverified.** All evidence is local Windows + SQLite + synthetic in-memory/file stores (dev file store not exercised by C7 tests beyond the selection helper). Windows cannot fsync directories (EPERM); the two real fsync tests are skipped and the Linux durability evidence remains an external platform gap (same existing boundary as the anonymous retention journal).
4. **A5 restore drill not executed by C7.** The bidirectional replay drill is A5's (`seed-restore-project` → backup before deletion → restore new root → `replay --offline-restored-database` → project 404/no objects; backup after deletion → replay no-op). C7 provides the journal/replay/CLI; the actual new-root restore, `PRAGMA integrity_check`, stale-lease/token cleanup, C4/C5 byte/digest checks, measured duration and loss window are A5 evidence. Stale lease/execution-token cleanup on restore is deliberately A5's spec §10.4 scope, not implemented here.
5. **In-flight upload → orphan-object race remains.** The store has no list API; access is revoked before inventory and uploads re-authorize per request, but a write already past authorization can leave an orphan object after the inventory/reclamation completes. This residual race is recorded, not claimed as zero residual. No synthetic project archive is delivered (plan §7): synthetic projects are only explicitly deleted.
6. **Deletion-status UI and C6 standards-library UI are not delivered** (C7 is server/API/CLI only); API/CLI only.
7. **Full `pnpm check/test/build/smoke`, browser acceptance, latency/capacity and GAUSSDB/container gates are Lead/A5 work.** C7 ran only targeted `tsx --test` suites and `tsc --noEmit` (full tsc exit 0 at the time of the run), consistent with the write-scope instructions; the final gates must be re-run after registration/wiring.
