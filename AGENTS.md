# Repository Guidelines

## Project Structure & Module Organization

This repository is currently design-only; application source and test directories do not exist yet.

- `README.md`: project status and documentation entry point.
- `docs/superpowers/specs/2026-10-19-engineering-legal-ai-platform-design.md`: current v1.1 implementation reference, two-stage scope, domain contracts, architecture, and acceptance criteria.
- `docs/reviews/2026-10-20-spec-feasibility-review.md`: historical v1.0 audit; its original line numbers and twelve-day assumptions do not describe the revised specification. The current spec maps R01–R18 in section 16.
- `docs/superpowers/specs/assets/`: reviewed interface screenshots.
- `.superpowers/`: ignored local preview sessions; keep these artifacts untracked.

Use the current specification for implementation decisions. Treat screenshots as layout references and sample data, not evidence that application features or acceptance criteria have passed.

## Delivery Scope & Architecture

- Deliver a working Demo within 12 days of the actual start, followed by one additional month of improvement. Keep the stages and their acceptance results separate; follow spec sections 12–13.
- The Demo retains four workflows and three fixed document templates: 专业分包合同、补充协议、催款函. Start with 房建机电安装专业分包 and represent the 专业分包人. Prioritize 合同审查 → 款项核对 → 证据整理 → 催款函; limit rule and template depth to the verified scope.
- Project isolation, real processing, immutable provenance, correct amount semantics, and human revision protection apply from the first Demo workflow. Reduce optional depth when needed; disclose unfinished functions instead of counting placeholder pages as completed.
- Use React/TypeScript/Vite, FastAPI, one independent Worker, and PostgreSQL in a modular monolith with shared backend code. Deploy through ECS/Docker Compose; use private OBS, MaaS, and verified OCR services through adapters.
- Share document processing, typed facts, source tracking, versioning, and exports. Load published scenario rule packs before supplementary keyword retrieval. Do not add vector infrastructure, Redis, a separate queue service, Kubernetes, or an open-ended agent platform without a demonstrated requirement.
- Preserve layout A. Full scanned-document processing, arbitrary contract drafting, original Word layout preservation, tracked-change editing, and real-time collaboration remain outside both stages unless scope is explicitly revised.
- Verify actual contest requirements, account permissions, HTTPS access, service capabilities, and budgets; do not infer availability or scoring requirements from reference links.

## Build, Test, and Development Commands

No application build scripts, package manifests, or test runners are configured. Current documentation checks are:

- `git status --short`: inspect working-tree changes.
- `git diff --check`: detect whitespace errors.
- `git diff -- <path>`: review a specific file.

When introducing application code, document verified installation, development, build, and test commands in `README.md`.
Check links, acceptance IDs, stage assignments, and consistency with the current specification when changing documentation. `git diff` does not include untracked files; inspect those directly.

## Coding Style & Naming Conventions

Keep Markdown concise with descriptive headings. Preserve Chinese terminology in existing product documentation. Name design specifications `YYYY-MM-DD-<topic>-design.md`.

For future code, use four-space Python indentation and two-space TypeScript/JSON indentation. Use `snake_case` for Python modules and functions, `PascalCase` for React components, and `camelCase` for TypeScript functions. No formatter or linter is currently configured; document tooling when adding it.

## Testing Guidelines

No testing framework or numeric code-coverage requirement is established. The specification separately defines business-quality release gates. Name future Python tests `test_*.py` and frontend tests `*.test.ts` or `*.test.tsx`.

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

- Persist tasks before execution. Use idempotent submission, short claim transactions, leases/heartbeats, and per-attempt execution tokens; stale attempts must not overwrite current results. Persist call-budget usage before external requests and retain it across recovery.
- Keep parsing in resource-limited subprocesses and human confirmation outside running jobs. Follow configurable input, execution, queue, and retry limits in spec sections 2, 9, and 10; do not silently truncate inputs or retry indefinitely.
- Record parsing/check coverage. Mixed scans, embedded content, or unsupported structures must not appear as a complete review. OCR support is limited to tested document types; preserve images, recognized values, and human corrections.
- Treat uploaded text and generated output as untrusted. Document instructions cannot grant tool permissions or bypass server-side authorization, calculations, and validation. Never replace failed processing with demonstration answers.
- Back up the database outside the ECS and protect OBS originals, verification evidence, and exports. Validate a complete project restore, including source access and historical downloads, rather than only restoring database rows. Follow retention/deletion rules and replay deletion records after recovery.

## Security & Domain Rules

Keep cloud credentials server-side and outside Git, logs, and screenshots. Enforce project membership for linked resource IDs, previews, downloads, task execution, and external sends; recheck permission before sending material to MaaS/OCR. Private files must not become public to make previews work.

Use synthetic or explicitly authorized documents, minimize sensitive fields, and follow spec section 10.5 for authorization, retention, generated-content markings, and deletion of originals and derived data. Immutable versions do not imply indefinite retention.

Distinguish material consistency checks from authoritative qualification verification. Unverified, not-found, or failed external checks remain unresolved; manual checks retain source, time, query conditions, operator, and proof. Valid citations do not establish correct legal applicability. Missing evidence, conflicting facts, and incomplete documents must remain visible and cannot be cleared by a review button.
