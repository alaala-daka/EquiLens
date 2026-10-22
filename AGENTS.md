# Repository Guidelines

## Sources and Specification Workflow

- `README.md`: runnable setup and honest implementation status.
- `spec/README.md`: accepted contract index; read the owning specification before changing behavior.
- `spec/00-overview.md`: Next.js single-application architecture and external service boundaries.
- `spec/01-product.md`: two-stage scope, business contracts, and AC-01–AC-26.
- `DEVELOPMENT.md` and `CONTRIBUTING.md`: engineering boundaries and contribution checks.
- `docs/deployment.md`: container and GHCR operation instructions.
- `docs/superpowers/` and `docs/reviews/`: historical designs, screenshots, and reviews; not current architecture authorities.
- `.superpowers/`: ignored local preview sessions; keep them untracked.

`spec/` owns accepted, testable contracts; `docs/` owns operating instructions and historical evidence.
Each durable rule has one owner. Update its spec, implementation, affected instructions, and validation together.
Unresolved proposals and implementation tasks belong in GitHub Issues; creating an Issue requires user authorization.
Treat screenshots as layout references and sample data, not evidence of implemented features or acceptance results.

## Delivery Scope & Architecture

- Deliver a working Demo within 12 days of the actual start, followed by one additional month of improvement. Keep the stages and their acceptance results separate; follow `spec/01-product.md` sections 12–13.
- The Demo retains four workflows and three fixed document templates: 专业分包合同、补充协议、催款函. Start with 房建机电安装专业分包 and represent the 专业分包人. Prioritize 合同审查 → 款项核对 → 证据整理 → 催款函; limit rule and template depth to the verified scope.
- Project isolation, real processing, immutable provenance, correct amount semantics, and human revision protection apply from the first Demo workflow. Reduce optional depth when needed; disclose unfinished functions instead of counting placeholder pages as completed.
- Use Next.js App Router and TypeScript in one Node.js application, managed with pnpm. Deploy the standalone container on ECS; use GaussDB centralized, private OBS, MaaS, and verified OCR through server-only adapters. Do not add a separate API or Worker service. Validate the selected GaussDB version, mode, driver and migrations before choosing an ORM.
- Share document processing, typed facts, source tracking, versioning, and exports. Load published scenario rule packs before supplementary keyword retrieval. Do not add vector infrastructure, Redis, a separate queue service, Kubernetes, or an open-ended agent platform without a demonstrated requirement.
- Preserve layout A. Full scanned-document processing, arbitrary contract drafting, original Word layout preservation, tracked-change editing, and real-time collaboration remain outside both stages unless scope is explicitly revised.
- Verify actual contest requirements, account permissions, HTTPS access, service capabilities, and budgets; do not infer availability or scoring requirements from reference links.

## Build, Test, and Development Commands

Use Node.js 24 and the pnpm version pinned in `package.json`. Commit `pnpm-lock.yaml`; use no npm or yarn lockfiles.

- `pnpm install --frozen-lockfile`: install locked dependencies.
- `pnpm dev`: local development server.
- `pnpm check`: ESLint, Next.js route types, and TypeScript checks.
- `pnpm build`: production standalone build.
- `pnpm start`: serve the production build.
- `pnpm smoke [url]`: check a running application, defaulting to `http://127.0.0.1:3000`.
- `docker compose up --build -d`: build and start the local container.
- `git diff --check`: detect whitespace errors.

Read `docs/deployment.md` before changing image publication. PRs build and verify containers without publishing.
Inspect untracked files directly; report only checks actually executed and distinguish local validation from GitHub CI runs.

## Coding Style & Naming Conventions

Use two-space TypeScript/JSON indentation, PascalCase components, and camelCase functions.
Keep routes thin; place domain behavior and cloud/database access in `src/server/` as it is implemented.
Use `server-only` at service boundaries and never import credentials or database clients into Client Components.
Use the Node.js runtime for database, file and model operations. Private project data must not enter shared caches.
Keep Markdown concise and preserve Chinese domain terminology. New accepted specifications use numbered topic names in `spec/`.

## Testing Guidelines

No unit-test framework or numeric code-coverage requirement is established yet. The smoke script checks the application and container entrypoints. Add meaningful `*.test.ts` or `*.test.tsx` behavioral tests with the relevant business implementation; follow the product specification for business-quality release gates.

Map behavioral tests to AC-01–AC-26, preserving the original AC-01–AC-18 IDs. Cover project/role isolation and revocation, source validity and coverage, amount semantics, retries and stale attempts, human revision protection, versioned DOCX exports, complete-project recovery, and visible model/OCR failures.

Use synthetic or explicitly authorized fixtures and new-input cases. Include normal/no-risk, missing evidence, conflicting facts, unsupported content, and document-instruction cases. Distinguish a valid no-risk result from all generated conclusions failing validation.

Follow section 12.1: at least 24 independent business cases for the Demo and 60 for the improved release, with the specified module distribution. Keep the separate 20–30 smoke checks out of accuracy denominators. Domain annotations and release thresholds must be set before running the validation set; report raw machine output, rejected items, missed issues, false positives, and unresolved items. Do not lower thresholds after seeing results or present finite-sample targets as general legal accuracy.

## Commit & Pull Request Guidelines

Existing history uses `docs: <summary>`. Continue short, imperative `<type>: <summary>` messages, such as `docs: clarify export review states`.

PRs should explain the change, reference relevant issues and specification sections or acceptance IDs, identify the delivery stage, and report validation performed and remaining gaps. Include screenshots for interface changes and update documentation when behavior or setup changes. Keep actual CodeArts/码道 development evidence tied to the delivered version; do not invent test results or efficiency metrics.

## Domain, Provenance & Version Rules

- Record project parties and contract relationships explicitly. Do not infer fixed legal roles from 甲方/乙方, or apply lawful-subcontract assumptions to other relationships. Check rule conditions, jurisdiction, dates, and applicable legal versions; only published, reviewed knowledge/rules may support legal conclusions.
- Key facts by party/contract, field meaning, time or period, unit, and accounting scope. Separate material-supported facts, human statements/corrections, proposed terms, and calculated facts. Preserve original values, evidence conflicts, and correction reasons; human confirmation does not establish objective truth.
- Store RMB amounts as precise decimals or integer fen. Keep measured value, net due amount, paid amount, not-yet-due amount, and disputed claims separate. Confirm cumulative/current-period scope, payment allocation, and deductions before computing 已到期未付额. Do not infer interest parameters or silently clamp negative balances to zero.
- Preserve immutable document versions, parse snapshots/fragments, fact/ledger versions, task input manifests, knowledge/rule/template versions, human revisions, validation/review records, and export snapshots. Reparse into a new snapshot; never replace sources already cited by an old result.
- Revalidate structure, citations, critical values, and required fields after every saved human edit; reset whole-result review status. Review cannot waive invalid references or missing required fields. Mark changed dependencies and create explicit new analyses instead of silently updating downstream results.
- Export saved revisions without new model generation. Keep selected text, validation/review state, template/render version, and unresolved/draft markings. Preserve existing export files when templates change.

## Tasks, Documents & Recovery

- Use a database-backed, in-process serial task runner in the single application. Initialize it once through an explicit Node.js runtime lifecycle, never on module import or during build. Next.js `after()` is not a durable queue. Persist tasks before execution. Use idempotent submission, short claim transactions, leases/heartbeats, and per-attempt execution tokens; stale attempts must not overwrite current results. Persist call-budget usage before external requests and retain it across recovery.
- Keep parsing in resource-limited subprocesses and human confirmation outside running jobs. Follow configurable input, execution, queue, and retry limits in `spec/01-product.md` sections 2, 9, and 10; do not silently truncate inputs or retry indefinitely.
- Record parsing/check coverage. Mixed scans, embedded content, or unsupported structures must not appear as a complete review. OCR support is limited to tested document types; preserve images, recognized values, and human corrections.
- Treat uploaded text and generated output as untrusted. Document instructions cannot grant tool permissions or bypass server-side authorization, calculations, and validation. Never replace failed processing with demonstration answers.
- Back up the database outside the ECS and protect OBS originals, verification evidence, and exports. Validate a complete project restore, including source access and historical downloads, rather than only restoring database rows. Follow retention/deletion rules and replay deletion records after recovery.

## Security & Domain Rules

Keep cloud credentials server-side and outside Git, logs, and screenshots. Enforce project membership for linked resource IDs, previews, downloads, task execution, and external sends; recheck permission before sending material to MaaS/OCR. Private files must not become public to make previews work.

Use synthetic or explicitly authorized documents, minimize sensitive fields, and follow `spec/01-product.md` section 10.5 for authorization, retention, generated-content markings, and deletion of originals and derived data. Immutable versions do not imply indefinite retention.

Distinguish material consistency checks from authoritative qualification verification. Unverified, not-found, or failed external checks remain unresolved; manual checks retain source, time, query conditions, operator, and proof. Valid citations do not establish correct legal applicability. Missing evidence, conflicting facts, and incomplete documents must remain visible and cannot be cleared by a review button.
