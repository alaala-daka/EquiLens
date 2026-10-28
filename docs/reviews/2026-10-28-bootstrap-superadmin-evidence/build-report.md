# Production build diagnosis — 2026-10-28

Outcome: default `pnpm build` passed, exit 0, with Next.js 16.4.2 Turbopack. No tracked source, compiler configuration, dependencies, or developer environment files were changed. Production harness may proceed.

## Evidence and commands

All commands ran from `C:\Users\aefar\source\repos\EquiLens`, using Node 24.14.1 and pinned pnpm 11.6.0 wrapper. Common process-local setup:

```powershell
$env:PATH = "$PWD\.superpowers\sdd\2026-10-27-a1-auth-http-session-plan\bin;$env:PATH"
$env:npm_config_manage_package_manager_versions = 'false'
```

1. Diagnostic restricted build: set process-local `NODE_OPTIONS` to `--require=$PWD\.superpowers\sdd\2026-10-28-bootstrap-superadmin\build-observer.cjs`, then `pnpm build *> .superpowers/sdd/2026-10-28-bootstrap-superadmin/build-observed-output.txt`. Exit 1. Observer records Turbopack loader subprocess `connect EACCES 127.0.0.1:<ephemeral port>`, then exit 0, explaining the otherwise misleading child-exited report. Observer logs argv and lifecycle/errors only; no environment values were logged.
2. Same observed build with elevated execution: `pnpm build *> .superpowers/sdd/2026-10-28-bootstrap-superadmin/build-observed-unrestricted-output.txt`. Exit 1 in 3 seconds. Observer showed no loader subprocess launched: the previous failure was replayed from generated build cache.
3. Verified resolved cache target was exactly repo `.next/cache/turbopack`, then removed only that generated directory:

```powershell
$taskRepo = (Resolve-Path '.').Path
$taskCache = (Resolve-Path '.next/cache/turbopack').Path
if ($taskCache -ne (Join-Path $taskRepo '.next\cache\turbopack')) { throw 'Unexpected cache path' }
Remove-Item -LiteralPath $taskCache -Recurse -Force
```

With elevated execution and diagnostic preload, ran `pnpm build *> .superpowers/sdd/2026-10-28-bootstrap-superadmin/build-observed-clean-unrestricted-output.txt`. Exit 0. Compiled successfully, TypeScript passed, route generation completed, standalone preparation completed.
4. Fresh process without diagnostic `NODE_OPTIONS`, elevated execution, same pinned pnpm setup: `pnpm build *> .superpowers/sdd/2026-10-28-bootstrap-superadmin/build-plain-unrestricted-output.txt`. Exit 0. This is the normal uninstrumented default build, with no webpack substitution or compiler workaround.

## Scope and limitations

The evidence supports denied loopback communication during restricted execution plus cached failure replay during the subsequent unrestricted run. It does not establish a source-code or Superdoc CSS defect. A restricted build was not rerun after success because it could reintroduce the cached denial. Build validation is local, not GitHub CI. No application service was started or stopped, no user process was killed, no secrets or `.env.local` contents were inspected, and no persistent developer environment setting was modified.
