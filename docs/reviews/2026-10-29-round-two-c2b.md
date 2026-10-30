# C2b subprocess partial evidence

2026-10-29 Windows Node local validation. `node scripts/build-material-parser.mjs` exited 0. `node node_modules/tsx/dist/cli.mjs --test src/server/materials/parser-process.test.ts` exited 0: 4 tests passed (DOCX parity, malformed ZIP, abort/deadline, synthetic credential exclusion). Earlier two runs exposed an empty DOCX fixture and Windows-added environment values; fixture now includes text and environment check targets a synthetic secret.

The worker uses a 512 MiB V8 heap ceiling, not a verified total-process RSS ceiling. Linux/container limits, PDF parity, dedicated handle-leak measurement, task executor and lifecycle integration remain unverified/unimplemented. No real OBS or AC acceptance claimed.

Build integration required: run `node scripts/build-material-parser.mjs` before test/dev/build and ship `scripts/generated/material-parser.cjs` in standalone runtime.

Executor increment: sequential manifest batches (1–10 references), immutable version/hash verification, repeated access refresh, private byte digest verification, subprocess cancellation, immutable snapshot writes. Snapshot transaction first conditionally locks the task row by project/running/token/attempt/unexpired lease; rejected attempts cannot write material metadata or fragments. Prior successful batch items remain real snapshots if a later item fails.

`node node_modules/tsx/dist/cli.mjs --test src/server/materials/executor.test.ts src/server/materials/parser-process.test.ts` exited 0: 8/8. Includes SQLite token/lease/attempt rejection, revoked access before private read, manifest hash mismatch, and partial output with claimed job forwarding. Full executor SQLite positive integration and PDF worker parity remain outstanding; no lifecycle registration yet.

Lifecycle increment: explicit `startMaterialRuntime()` is called by instrumentation after its Node/build guards and before the unified runner. It registers the lazy executor without connecting storage at import. Non-overlapping 60-second maintenance recovers at most 10 upload intents, reauthorizes the originating account/project and submits version-idempotent tasks; project Word and export repair hooks run separately with fixed safe failure messages. OBS stays unavailable. No second runner added.

Latest focused suite: 9/9 passed, now includes PDF subprocess/pure-parser parity. TypeScript run still fails only on two C3 `EditorCopyInput.source` test fixtures. Positive full SQLite TaskRepository-to-snapshot integration and lifecycle behavioral tests remain outstanding; do not count this as full C2b acceptance.

Positive SQLite closure added: queued PDF upload with injected synthetic store and authorization -> durable TaskRepository submit -> claim -> real subprocess parser -> guarded immutable snapshot/fragments -> terminal task state. Initial fixture failed because its project FK target was absent; fixed fixture creates project row. This uses injected authorization, not real account/session acceptance.

`node node_modules/tsx/dist/cli.mjs --test src/server/materials/*.test.ts src/server/tasks/*.test.ts` exited 0: 90/90 passed (local, 6.9s reported test duration). Lifecycle timer/build-import assertions remain unexecuted; registration order/build guard were inspected in source only.

Lifecycle validation complete: extracted injected lifecycle factory verifies inert construction, registration before first repair, repeated-start idempotency, one pending timer, no repair overlap, safe failure retry. Authorization helper test verifies fresh checks and zero submission after revocation. Instrumentation guard/order and recovery idempotency key have source assertions; these are not a live Next production-build execution.

`node node_modules/tsx/dist/cli.mjs --test src/server/materials/lifecycle.test.ts src/server/materials/upload-intents.test.ts` passed 8/8. `node node_modules/typescript/bin/tsc --noEmit --pretty false` then exited 0 after fixing a recovery callback closing parenthesis. Earlier material/task suite remains 90/90; not redundantly rerun.
