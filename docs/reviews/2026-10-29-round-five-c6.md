# Round Five — C6 controlled knowledge/rule publication (implementation evidence)

- Owner: Agent C (`agent-c6-knowledge`), task `task-13` (R5-C6).
- Branch: `alaaladaka/round5/business`; base/HEAD when work started: `04f8c40` ("feat: freeze round-five business contracts").
- Contract: `docs/superpowers/plans/2026-10-29-round-five-plan.md` §3 (0011 DDL), §4.1/§4.2, §5 C6, §6/§7; independent plan review `.superpowers/round5/plan-review.md`; owning specs `spec/01-product.md` §7.1, §8.2.2, §9.1.
- Scope actually written: `src/server/knowledge/**`, `scripts/knowledge-maintenance.mts`, `src/server/reviews/{executor,runner,runtime,registry}.ts` + `registry.test.ts`, minimal `tools/contract-review/src/pack.ts` change, `docs/reviews/2026-10-29-round-five-c6.md`. No `spec/**`, `tasks/**`, `results/**`, `exports/**`, `materials/**`, `instrumentation.ts`, `package.json`, `migrations*` or `.env.example` edits; no `git add`/`commit`; HEAD remains `04f8c40`; all changes are working-tree modifications/untracked files for the Lead to review and commit.

## 1. Delivered behaviour

### 1.1 Migration 0011 (Lead registers)

`src/server/knowledge/schema.ts` exports `statements` — exactly the DDL frozen in plan §3 (two tables, `UNIQUE(kind, artifact_id)`, `UNIQUE(publication_id, version)`, two indexes; nullable `reviewer`/`verified_at`/`review_evidence`; provider-safe: only `CREATE TABLE`/`CREATE INDEX`, no CHECK/partial index/CTE/RETURNING). `src/server/knowledge/migrations.ts` exposes `knowledgeBusinessMigrations()` / `applyKnowledgeMigrations(db)` used by the private CLI and tests: they append the identical frozen `{id:"0011", statements}` only while `src/server/database/migrations.ts` has not registered 0011 yet, and always prefer the Lead-registered entry once present (so the frozen checksum is the single authority; a divergent manual registration fails closed through the existing migration-history check).

**Lead integration action:** register `0011` in `src/server/database/migrations.ts` by importing `statements as knowledgeStatements` from `src/server/knowledge/schema` and appending `{ id: "0011", statements: knowledgeStatements }`; do not retype/reflow the DDL (checksum is permanent). Freeze the 0011 checksum and add the empty-DB/repeat/rollback/0001–0010-unchanged assertions in `migrations.test.ts` as planned.

### 1.2 Publication state machine (`knowledge/publication.ts`)

- States `draft | pending_verification | published | disabled`; version content is immutable (`repository.publish`/`disable` only write lifecycle columns; content columns are never updated).
- `submit` creates version `draft`, or `pending_verification` when `--reviewer` is supplied at submit (both with null `verified_at`/`review_evidence`). Version numbers are generated transactionally; `UNIQUE(publication_id, version)` plus a one-shot retry covers provider-parity unique violations.
- `publish` guards before any write: operator must be an existing enabled **superadmin** account re-read through `AuthService.account` (so a subsequently disabled/demoted account is refused); reviewer must be in `EQUILENS_DOMAIN_REVIEWERS` (trimmed list; empty/absent list refuses all publishing); reviewer must differ from the operator account id **and** username; the pending reviewer (if recorded at submit) cannot be swapped; `verified_at` must be a UTC ISO-8601 instant not before the version and not in the future; evidence must be 1–500 chars; `--expected-sha` must equal the stored version digest. Missing/invalid values are rejected with **no state change** (tests assert the row still has `state=draft/pending`, null review fields).
- Publish-grade content rule: only a pack whose manifest/rules/sources are all `已发布` (and whose basis sources exist) can be published — `rulePackFromStored` re-validates the stored columns and rejects unpublished basis.
- Tamper guard: the stored payload/sources/applicability digest is recomputed from the row and compared with the `sha256` column before publishing; a payload changed after submission is rejected without state change. The pinned-pack loader repeats the same check before a task executes.
- Supersede: publishing a correction inserts a new version and conditionally disables the previously published version in the same transaction (`changed rows === 1` assertions; `supersedes_id` recorded, old row keeps content, `disabled_reason = 已被发布版本 N 替代`).
- `disable` requires a published version, records `disabled_at`/`disabled_reason`, keeps history readable, and cannot be repeated.
- Fake-signoff caveat: this is an operational control (operator + allowlisted reviewer + reviewer≠operator + evidence + digest), not proof of a real domain review. No real domain reviewer/legal sign-off exists in this repository; all published content in tests/the e2e is synthetic and labelled as such.

### 1.3 Content contract (`knowledge/content.ts`)

- Rule-pack JSON document: `{schemaVersion:1, manifest, rules, sources}`; parsed through a new shared `parseInlineRulePack` in `tools/contract-review/src/pack.ts` (the file loader refactored onto the same `assemblePack` validation path, so both paths share duplicate/kind/basis/source validation; existing file-loader behaviour unchanged — tool tests pass).
- Stored columns: `payload_json` = `{schemaVersion, manifest, rules}`, `sources_json` = sources, `applicability_json` = `{scene, role:"专业分包人"}`; `sha256` = SHA-256 of canonical JSON over the three parsed values. Rules must declare `appliesTo.scene === declared scene` and `role === "专业分包人"`.
- File-reference rejection: forbidden key names (`ruleFiles`, `sourceFiles`, `file(s)`, `path(s)`, `filePath`, `dir`, `directory`, `objectKey` …) and path-shaped string values (drive-letter/UNC/absolute/`./`/`../`/`file:`) are rejected on submit/validate; nothing path-like is stored (test asserts stored columns contain no paths).
- Only `rules` has an accepted content contract this round (the only formal-task consumer). `knowledge`/`templates` publication categories exist in the shared schema/`PublicationPin` type but have no accepted content contract or consumer yet; `submit` rejects them explicitly instead of inventing one (recorded as a limitation in §5).

### 1.4 Resolver three states (`knowledge/resolver.ts`, `knowledge/runtime.ts`)

- `resolvePublicationBasis`: for `contract-review`, `scene:auto` follows the runner default (`mep-sub-2026`). No version history for the resolved scene → `none` (existing debug/unsigned path). History exists → fail-closed: any publication whose latest version is `draft`/`pending_verification`/`disabled` → `blocked`; more than one published rule publication for the scene → `blocked` (ambiguous); zero published rules but history → `blocked`; exactly one published rule pack → `pinned` with the immutable `{id: publicationId, versionId, sha256}` refs (knowledge/templates arrays pinned only when such published versions exist; today they stay empty). A pending correction blocks new submissions while the previous version is still published (literal plan-review BLOCK-5 fail-closed rule; test covers it).
- Digest re-check before pinning; tampered stored content throws, and through W0's `resolvePublication` seam becomes HTTP 503 — never a silent debug downgrade. Missing resolver is also 503 (W0 behaviour; test asserts).
- Only `contract-review` consumes a published basis today; other task kinds resolve `none`.
- `src/server/knowledge/registration.ts` is the testable registration seam; `src/server/knowledge/runtime.ts` is the server-only lifecycle entry (`startKnowledgeRuntime()`), following the same static-import pattern as the other runtimes. It registers the DB-backed resolver through `registerPublicationResolver` exactly once (`knowledgeRuntimeStarted()` for startup assertions) and has no import-time side effects (the lazy provider reads the database only when a task is submitted; it does not connect during registration). **Lead integration action:** call `startKnowledgeRuntime()` in `src/instrumentation.ts` before `startTaskRunner()` (and before serving task submissions).
- Pinned-pack loader `loadPublishedRulePack(repository, ref)`: re-reads the immutable DB version, verifies publication id/kind/sha and recomputed content digest, rebuilds/re-validates the published pack, returns `{pack, scene, disabled}`; draft/pending/wrong-ref/tampered rows are rejected; a version disabled after submission still loads and is flagged `disabled`.

### 1.5 Reviews integration (published pin)

- `src/server/reviews/runner.ts`: `ProjectReviewRunnerInput.published` carries the server-resolved pin; the production runner loads the DB pack through the injected `loadPublishedPack` and calls the agent review in `mode:"published"` with that pack (code-side scene bundle is used only for skill selection/display label; the file rule pack is never used when pinned; a missing/invalid pinned pack fails the task instead of falling back to debug). It embeds the fixed refs in the result value as `publicationBasis = {rules, knowledge}`, and prepends the fixed warning `依据已停用：本次任务按提交时固定的发布版本执行；该版本已停用，新提交不再接受此依据。` when the pinned version was retired after submission.
- `src/server/reviews/executor.ts`: reads `job.manifest.publications` back from the immutable manifest (old/queued manifests have none → debug path unchanged), rejects a malformed/empty-rule pin before any model call, passes the pin to the runner, verifies the saved result is `mode:"published"` with exactly the pinned refs embedded (or `mode:"debug"` with no embedded basis), and records the pinned refs in the result dependency list (`kind:"rule"` per ref; the debug path keeps the previous built-in rule dependency).
- `src/server/reviews/runtime.ts`: production runner wires `loadPublishedPack` to `knowledgeRepository()` + `loadPublishedRulePack` (same lazy DB repository the resolver uses).
- `src/server/reviews/registry.ts`: result validator policy per spec §8.2.2 — `debug` valid only without an embedded publication basis; `published` valid only with the executor-embedded fixed refs (non-empty rules array, each `{id,versionId,sha256}` well-formed, no duplicates), bare `mode:"published"`, malformed refs and debug-with-basis are `invalid`; the old `UNSIGNED_BASIS` issue code is retained for the bare/absent basis case. The validator has no DB access; authenticity comes from the executor's pre-save DB check (documented in the comment).
- `tools/contract-review/src/pack.ts` is the only tools change: `parseInlineRulePack` + shared `assemblePack` validation path. No `tools/contract-review/src/runner.ts` exists in this repo; the production run path is `src/server/reviews/runner.ts`, and the existing agent/review code already supports explicit `mode` and an injected `pack`, so no additional change there was needed.

### 1.6 Private maintenance CLI

- `scripts/knowledge-maintenance.mts`: explicit initialization only (loads `.env.local`, requires explicit `DATABASE_PROVIDER`, absolute `SQLITE_PATH` for SQLite, connects, applies migrations, then dispatches). Commands: `list [--kind] [--artifact] [--scene] [--state]`, `show --version | --kind+--artifact`, `validate --kind --scene --file`, `submit --kind --artifact --scene --file --operator [--reviewer]`, `publish --version --operator --reviewer --verified-at --expected-sha --evidence`, `disable --version --operator --reason`. Exit codes: 0 success, 1 refused/known failure, 2 invalid command line. There is **no HTTP write route** (grep: no knowledge/publication references under `src/app`); redacted output prints ids/states/digests/核对人/通知 counts only, never rule/source text, payloads, SQL or file paths. `src/server/knowledge/cli.ts` holds the testable dispatch; `service.ts` holds explicit DB/service wiring. `package.json` script entry + test glob are Lead-owned (see §5).

## 2. Tests executed (actual commands/exit codes)

All commands were run from the repo root on Windows/Node 24/pnpm, SQLite in-memory only; no real model/OCR/network call.

| # | Command | Exit | Result |
| - | - | - | - |
| 1 | `pnpm exec tsx --test src/server/knowledge/publication.test.ts` | 0 | 16 pass / 0 fail (state machine, draft/pending null review fields, publish guards without state change, fake signoff/operator re-read, digest tamper, immutability/disable, supersede, path/content guards, redaction, allowlist parsing) |
| 2 | `pnpm exec tsx --test src/server/knowledge/resolver.test.ts` | 0 | 12 pass / 0 fail (three states, pending/disabled/ambiguous/superseded-pending blocking, correction pins newest, per-scene isolation, tamper → 503 through seam, missing resolver → 503, registration idempotence, pinned-pack loader including disabled/tampered/draft) |
| 3 | `pnpm exec tsx --test src/server/knowledge/cli.test.ts` | 0 | 6 pass / 0 fail (validate/list/show/submit/publish/disable round trip, exit 1/2 mapping, redaction, generic internal-error message, fake-signoff refusals) |
| 4 | `pnpm exec tsx --test src/server/knowledge/published-integration.test.ts` | 0 | 6 pass / 0 fail (pinned DB pack runs `mode:"published"`, result embeds refs + dependency rows, disabled-after-submit executes immutable pack with `依据已停用` warning while new submissions resolve `blocked`, bare published claim rejected, malformed pin rejected before model call, old/no-publications manifest keeps debug path, browser `publications` injection and cross-project refs rejected) |
| 5 | `pnpm exec tsx --test src/server/knowledge/{publication,resolver,cli,published-integration}.test.ts src/server/reviews/{registry,runner,executor,input,registration}.test.ts` | 0 | **77 pass / 0 fail** (all C6 tests + all affected A4c review tests) |
| 6 | `pnpm exec tsx --test tools/contract-review/tests/pack.test.ts tools/contract-review/tests/review.test.ts tools/contract-review/tests/scene-applicability.test.ts` | 0 | 13 pass / 0 fail (pack.ts refactor keeps file rule-pack behaviour) |
| 7 | `pnpm exec tsx --test src/server/tasks/catalog.test.ts src/server/tasks/repository.test.ts src/server/results/service.test.ts src/server/results/registry.test.ts src/server/results/http.test.ts src/server/exports/*.test.ts` | 0 | 40 pass / 0 fail (adjacent W0/results/exports regression) |
| 8 | `pnpm exec tsc --noEmit` | **2 (not C6)** | Full-repo typecheck currently fails only on parallel C5 files (`src/components/business/platform/drafting-form.ts`, `drafting-form.test.ts`, `project-drafting-workspace.tsx`, `src/server/drafting/http.test.ts`). Filtered output for C6-owned paths (`src/server/knowledge`, `src/server/reviews`, `scripts/knowledge-maintenance`, `tools/contract-review/src/pack.ts`): **0 errors**. Re-run the full `pnpm check`/`tsc` at integration once C5/C4-UI land. |
| 9 | `git diff --check` | 0 | no whitespace errors |

## 3. Private CLI end-to-end evidence (local temporary SQLite)

Run with `DATABASE_PROVIDER=sqlite`, an absolute `SQLITE_PATH` under the ignored `.superpowers/round5/` directory, `EQUILENS_DOMAIN_REVIEWERS=domain-reviewer`, and a temporary synthetic superadmin account created by an ignored seed script (`.superpowers/round5/c6-e2e-seed.mts`). The only published data is the synthetic fixture pack labelled "合成测试规则包（C6 CLI 证据夹具，非法律规则）"; it is not application seed data and never targets `data/`. An earlier attempt to derive the draft fixture with a PowerShell string replace produced mojibake, so the draft file was rewritten with a UTF-8 writer before the final run; that console-encoding step is not a product defect.

| Step | Command | Exit | Observed |
| - | - | - | - |
| seed | `pnpm exec tsx .superpowers/round5/c6-e2e-seed.mts` | 0 | temporary `c6-operator` superadmin account created; migrations incl. 0011 applied |
| list (empty) | `tsx scripts/knowledge-maintenance.mts list` | 0 | `暂无发布记录。` |
| validate publishable | `... validate --kind rules --scene mep-sub-2026 --file .superpowers/round5/c6-e2e-pack.json` | 0 | `校验通过（结构）；sha256=fdc0…76bb`, `可发布：内容已达到发布要求。` |
| validate draft | `... validate ... --file .superpowers/round5/c6-e2e-draft.json` | 0 | structure ok, sha256, warnings + 7 `发布阻塞：…` lines (manifest/rules/sources not published) |
| submit | `... submit --kind rules --artifact synthetic-contract-review --scene mep-sub-2026 --file … --operator <superadminId>` | 0 | `已提交：rules/synthetic-contract-review v1 [草稿] versionId=e825…2c4d sha=fdc0…76bb` |
| publish wrong sha | `... publish --version <id> … --expected-sha 000…0 --evidence …` | 1 | `期望摘要与待发布版本不一致。` (state unchanged; list still `[草稿]`) |
| publish | `... publish --version <id> --operator <id> --reviewer domain-reviewer --verified-at <now ISO> --expected-sha <sha> --evidence 合成测试核对证据…` | 0 | `已发布 … [已发布]`, 核对人/核对时间/发布时间 printed |
| list --state published | `... list --kind rules --state published` | 0 | one `[已发布]` line, no rule/source text |
| show | `... show --kind rules --artifact synthetic-contract-review` | 0 | metadata + counts (规则数=1 来源数=1), no rule/source text |
| disable | `... disable --version <id> --operator <id> --reason 合成测试：CLI 证据停用` | 0 | `已停用 … [已停用]`, 停用时间/原因 |
| list after disable | `... list` | 0 | latest `[已停用]` (history kept) |
| bad operator | `... submit … --operator 9999…` | 1 | `操作者必须是现有且启用的超级管理员账号。` |
| path-shaped content | `... validate … --file .superpowers/round5/c6-e2e-path.json` | 1 | `内容包含文件路径引用（内容.sources[0].text）。` |
| unknown flag | `... list --bogus x` | 2 | `维护命令包含未知参数：--bogus` + usage |

## 4. Requirement traceability

| Plan/spec requirement | Implementation | Test |
| - | - | - |
| 0011 two tables, unique constraints/indexes, nullable review fields | `knowledge/schema.ts` | migration applied in every knowledge test fixture; CLI e2e |
| draft/pending can have null reviewer/verified_at/review_evidence | `publication.ts submit` | publication.test #1 |
| published transition requires reviewer+time+evidence+expected sha; failure changes nothing | `publication.ts publish`, `access.ts` | publication.test #2 |
| fake signoff: enabled superadmin operator re-read, allowlist reviewer, reviewer≠operator | `access.ts`, `AuthService.account` | publication.test #3/#4/#16 |
| only published sources/basis in published packs | `content.ts blockersFor`, `rulePackFromStored` | publication.test #5 |
| immutable published version; supersede = new version + conditional disable; disable keeps history | `repository.publish/disable`, `publication.ts` | publication.test #6/#7 |
| digest tamper rejected on publish and on load | `publicationDigest` re-check | publication.test #6; resolver.test #9; integration.test #5 |
| path-shaped content/file references rejected, no paths stored | `content.ts assertNoFileReferences`, artifact-id guard | publication.test #8; CLI e2e |
| resolver `pinned` only for exactly one published rule pack per scene; `none` only without history; `blocked` for draft/pending/disabled/ambiguous | `resolver.ts` | resolver.test #2–#8 |
| missing resolver fail-closed 503, no silent debug downgrade | W0 `tasks/publications.ts` + resolver | resolver.test #9/#10 |
| pinned pack loaded from DB in `mode:"published"`, no file fallback, fixed refs embedded, dependency recorded | `reviews/{runner,executor,runtime}.ts` | integration.test #1 |
| bare `mode:"published"` invalid; embedded refs required | `reviews/registry.ts` | registry.test (C6 cases) |
| disabled-after-submit executes pinned immutable content + `依据已停用`; new submissions blocked | runner disabled flag/warning; resolver blocked | integration.test #2 |
| old manifests/queued tasks parse and keep debug path; browser cannot inject `publications` | W0 manifest seam + executor reader | integration.test #6; tasks/catalog tests |
| private CLI list/validate/submit/publish/disable/show, explicit DB init, redacted output, no HTTP write route | `scripts/knowledge-maintenance.mts`, `knowledge/cli.ts` | cli.test 6 pass; CLI e2e; grep `src/app` = no references |
| `startKnowledgeRuntime()` registers resolver, no import-time side effects | `knowledge/registration.ts` (testable seam) + `knowledge/runtime.ts` (server-only lifecycle) | resolver.test #1; Lead wires instrumentation |

## 5. Not run / limitations / integration actions

1. **No real domain reviewer and no real published legal rule exists.** Everything "published" in tests and the CLI e2e is a synthetic fixture explicitly labelled "非法律规则/非验收证据". No production `已发布` pack was created in the application database; no legal-review/accuracy claim is made. The operator/reviewer guards are operational controls, not identity proof.
2. **GaussDB not run.** All persistence tests ran on `node:sqlite` (`:memory:`). DDL is provider-safe (only CREATE TABLE/INDEX; no CHECK/partial index/CTE/RETURNING); transitions use conditional UPDATE + `changes === 1`; unique violations are handled provider-parity style. PostgreSQL/GaussDB behaviour (unique codes, DATETIME/text handling) remains unverified until a real instance is available.
3. **Migration 0011 is not registered yet** (Lead-owned `src/server/database/migrations.ts`; plan §6 says Lead registers/freezes checksums). The private CLI/tests use `knowledgeBusinessMigrations()` which appends the identical frozen statements only while 0011 is unregistered; after Lead registration the registered entry is used. Without Lead registration on a deployed/app DB, the business-migration history check will fail closed once the knowledge tables were created by the CLI — the Lead must land 0011 in the same integration commit as the instrumentation wiring.
4. **Integration wiring still owned by Lead:** register 0011; call `startKnowledgeRuntime()` in `src/instrumentation.ts` before `startTaskRunner()`; add `src/server/knowledge/*.test.ts` to the `package.json` test glob and a `knowledge:maintain`-style script entry; keep `.env.example` `EQUILENS_DOMAIN_REVIEWERS` documentation (already present). `src/server/reviews/runtime.ts` already wires the DB pinned-pack loader, so no Lead edit is needed there.
5. **No HTTP route/UI/browser verification:** this round C6 is a private maintenance mechanism with no HTTP write route and no standards-library UI (P1 not delivered); no browser acceptance was performed for C6.
6. **Knowledge/template publication categories not delivered:** only `rules` has an accepted content contract and formal-task consumer; `knowledge`/`templates` rows/categories exist in the schema and `PublicationPin` type but `submit` rejects them (no invented contract). The spec §7.1 mechanism wording covers knowledge and rules; this round's formal-task integration is rule packs only — documented, not claimed as complete.
7. **Full-repo `pnpm check`/`pnpm test`/`pnpm build`/`pnpm smoke` were not run** (forbidden for this work package; Lead runs full gates at integration). Full `tsc --noEmit` currently exits 2 only because of parallel C5 in-progress files; C6-owned paths show 0 errors (see §2 row 8).
8. **No real model call:** the pinned review path was exercised with an injected deterministic `review` function; the real `reviewWithAgent` call path is unchanged except for `mode`/`pack` inputs. No model/SDK request was made by any test.
9. **Cross-project reads:** publication records are global public knowledge (not project-private, spec/04), so C6 adds no project-scoped publication reads. Cross-project material/result access continues to be rejected by the existing project authorization; the seam test asserts browser-submitted cross-project refs and browser-injected `publications` are rejected. This is not a new C6 read API.
10. **Temporary e2e artifacts** live in the ignored `.superpowers/round5/` directory (`c6-e2e.sqlite`, synthetic pack/draft/path JSON, seed script) and are not part of the deliverable.
