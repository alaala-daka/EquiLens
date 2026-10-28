# Synthetic browser reproduction

These are sanitized snapshots of the harness used for the local TLS checks, with the fixture-script location and its relative imports adjusted to this reviewable directory. The application source is not modified. `../source-manifest.txt` records the frozen source hashes and lengths; the baseline commit and uncommitted-change caveat are in the validation report. The public synthetic passwords in these scripts must never be used for a real account.

Run from the repository root with the pinned pnpm 11.6.0 wrapper, Node 24, Python Playwright 1.64.1, system Edge, and Python cryptography available. The proxy binds only localhost:3443 and forwards to our isolated production server on localhost:3187 without rewriting Origin or cookies. Ports must be unused. Stop only your own processes afterward.

1. Build the unchanged application using `pnpm build`.
2. Set `DATABASE_PROVIDER=sqlite` and `SQLITE_PATH` to the absolute scratch path `.superpowers/sdd/2026-10-27-a1-auth-http-session-plan/task8-localtls-synthetic.sqlite`. Use a new synthetic database for each complete rerun so account/source quotas reflect only that run.
3. Seed synthetic accounts: `pnpm exec tsx docs/reviews/2026-10-27-a1-auth-evidence/reproduce/synthetic-fixture.ts seed`.
4. Set `APP_ORIGIN=https://127.0.0.1:3443`, `HOSTNAME=127.0.0.1`, `PORT=3187`, and run `pnpm start`. Confirm the server is ready; this is a long-running process, not a successful process-exit check.
5. Copy `localtls-proxy.py` into an ignored scratch directory and run it there. It generates a new one-day self-signed localhost/127.0.0.1 SAN certificate and private key in its own directory. Never copy generated key files into evidence or change the system trust store.
6. Run `browser-localtls.py`, then `browser-supplement.py`, from the repository root. The browser uses an isolated headless Edge context with `ignore_https_errors=True`; this is local synthetic TLS evidence, not valid public HTTPS acceptance. The output screenshots have empty password fields.

The browser harness intentionally aborts a login request for the network-failure case, and holds/fulfills a 401 response for duplicate-submit timing. Those responses are disclosed simulations, not real credential verification. Correct/incorrect credentials, cookie/session checks and logout otherwise use the actual production API. Expiry changes only the synthetic database's `expires_at`; disable/enable uses private AuthService maintenance. Neither establishes 12 hours of elapsed browser time or project authorization.

No recorded cookies, tokens, password hashes, actual environment files, certificates or private keys are included. Original raw harnesses/logs remain ignored locally. This package documents reproduction; it was not rerun for the editorial review correction.
