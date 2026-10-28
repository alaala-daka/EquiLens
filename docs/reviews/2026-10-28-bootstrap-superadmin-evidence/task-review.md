# Task 1 independent review

## Scope and evidence

Reviewed the supplied base-7351fd1 working-tree diff package once, the implementation report, task plan, current changed authentication/migration files, and product specification §3.3. Included the parent's subsequent §3.2 login/session response-table correction (`user.role`); the diff snapshot predates this editorial correction. No implementation edits, Git mutations, or test-suite reruns performed.

Unchanged code inspected only for concrete risks: `database/connection.ts` for transaction serialization, rollback, and login-versus-role-maintenance locking; `auth/password.ts` for bootstrap hashing resource bounds; `auth/runtime-core.ts` for initialization failure/readiness ordering. These checks support the assessment below and do not establish GaussDB behavior on an actual server.

## Specification verdict: PASS for reviewed role-foundation implementation

No actionable specification findings.

- ADMIN-01: migration 0003 adds a non-null default member role; ordinary create relies on that default. Existing migrations 0001/0002 are unchanged in the reviewed delta. Login and session identities validate the persisted role, and HTTP projection includes it without exposing credentials.
- ADMIN-02: bootstrap is optional only when both settings are absent; incomplete/empty/invalid configuration fails. Username and password validation precede mutation. Password hashing occurs outside the short provisioning transaction. The unique marker, account, role and audit commit together. A same-name ordinary account cannot be taken over; transaction rollback removes the provisional marker. Existing completion markers prevent password, role, enabled-state or account changes on subsequent valid initialization.
- ADMIN-03: both new guards resolve a fresh valid session/current account and require the persisted superadmin role. Anonymous/invalid/revoked/expired/disabled sessions fail authentication, members fail authorization, and infrastructure errors fail unavailable. No browser role assertion or cached authorization is used.
- ADMIN-04: grant/revoke, credential revision increment, every-session deletion and audit share a transaction. Reset/disable/enable preserve role; enable cannot restore deleted sessions. Login does not issue stale elevated identity during password verification: maintenance increments revision; the signing transaction conditionally locks the same account row using its original revision, rejects a mismatch, and reads the current role only after that guard succeeds.
- ADMIN-05: runtime initialization invokes bootstrap after migration and before returning the service for readiness. Bootstrap does not execute at import time. Failure prevents readiness. The changes introduce neither an HTTP maintenance endpoint nor anonymous-resource takeover. Formal project authorization is correctly documented as a separate unfinished integration.

## Code-quality verdict: PASS

No actionable code-quality findings. The change stays within the existing service/runtime/database boundaries, reuses the bounded password primitive, keeps role validation centralized, exposes guards through server-only entrypoints, and retains safe public error mapping. The behavioral tests cover the principal bootstrap, maintenance, rollback, identity and restart cases. Documentation states operational recovery and deployment limits accurately.

## Validation and limits

The implementation report records focused authentication/database/client checks at 64/64 passed; the full suite at 401 total, 400 passed, one skipped (before the final additional atomic-maintenance test, which is included in the focused result); `pnpm check` and whitespace check passed. These are supplied execution evidence, not suites independently rerun by this review, and not GitHub CI results.

The parent reports the current production build failed with a local Turbopack CSS child-transport failure and has a separate diagnostic in progress. This review does not claim build, production start or smoke passed. The implementation report delegates actual CLI/production HTTP checks to the parent; no completed evidence for those was supplied to this review.

GaussDB on its actual version/mode, cross-process initialization against it, Linux container behavior, valid public HTTPS, and formal project-resource authorization remain unverified and separate release gates. The concurrent-initialization test uses shared local SQLite connection serialization; it proves that local case, not every deployment topology. Static transaction analysis supports fail-closed behavior, but does not replace those environment checks.

## Findings

None. No severity/file/line entries warranted. Approval concerns the reviewed implementation and contract alignment; outstanding build and environment validation must retain their actual status in final delivery.
