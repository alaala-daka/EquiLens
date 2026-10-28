# 预设超级管理员实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 部署时显式创建一次可撤销的超级管理员，提供真实角色及管理权限守卫。

**Architecture:** 复用 A1 认证、共享数据库和显式运行生命周期；追加业务迁移保存角色与一次性初始化标记。私有维护命令管理角色，服务器每次重新核验权限。

**Tech Stack:** Node.js 24、Next.js App Router、TypeScript、pnpm 11.6.0、node:sqlite / gaussdb-node。

## Global Constraints

- `spec/01-product.md` §3.3 是角色、初始化、维护及 ADMIN-01—ADMIN-05 的唯一行为契约。
- 不修改既有迁移 0001/0002，不接管匿名资料，不内置默认账号或密码，不新增 HTTP 账号维护或页面。
- 凭据不得进入源码、日志、命令参数或镜像。
- 正式项目授权、GaussDB、有效公网 HTTPS 分别记录，不能以本地测试代替。
- 不自动推送或部署；本次实现不自动提交，保留可审查工作区。

### Task 1: 超级管理员完整认证增量

**Files:**
- Modify: `src/server/database/migrations.ts`、`src/server/auth/service.ts`、`src/server/auth/runtime.ts`、`src/server/auth/handlers.ts`、`src/server/auth/access.ts`、`src/server/auth/errors.ts`、`scripts/manage-account.mts`
- Create: `src/server/auth/bootstrap.ts`、`src/server/auth/admin.test.ts`
- Modify affected tests: `src/server/auth/*.test.ts`、`src/lib/auth/*.test.ts`、`src/server/database/migrations.test.ts`
- Update: `.env.example`、`README.md`、`docs/deployment.md`

**Interfaces:**
- `Account.role: "member" | "superadmin"` is required and derives from stored role in every login/session identity.
- `bootstrapAdmin(auth: AuthService, env: NodeJS.ProcessEnv): Promise<void>` parses optional paired credentials; `AuthService.bootstrapAdmin(username: string, password: string): Promise<void>` applies atomic one-time provisioning.
- `AccountOperation.action` adds `"grant-admin" | "revoke-admin"`; password accepted only for create/reset.
- `createAccountAccess` and server-only `access.ts` expose `requireSuperAdmin(request: Request): Promise<AuthIdentity>` and `revalidateSuperAdminSession(sessionId: string): Promise<AuthIdentity>`; ordinary roles throw `AuthError("FORBIDDEN", ...)`.

- [x] Add behavioral tests before implementation: initialize empty database; migrate existing account to member; verify configured login role; no plaintext password stored; restart with changed valid credentials preserves account; collision/invalid config leaves no partial data; concurrent initialization yields only one account; late failure rolls back marker/account/audit; file-backed reopen retains marker and disabled/demoted state.

```ts
await bootstrapAdmin(auth, { BOOTSTRAP_ADMIN_USERNAME: "synthetic-admin", BOOTSTRAP_ADMIN_PASSWORD: "Synthetic password 123!" })
const login = await auth.login("synthetic-admin", "Synthetic password 123!", "deployment")
assert.equal(login.user.role, "superadmin")
assert.equal((await auth.session(login.token))?.account.role, "superadmin")
```

- [x] Run the new focused tests through `node node_modules/tsx/dist/cli.mjs --test src/server/auth/admin.test.ts` and record the actual failure.
- [x] Append migration 0003 with default member role and persistent one-time marker; implement bootstrap with a short transaction after bounded async password hashing. Existing marker means no mutation; no marker plus duplicate username means explicit conflict; audit and marker commit atomically. Validate role on reads and fail closed on unsupported values.
- [x] Extend role maintenance, session revocation and private CLI allowed actions. Keep existing scrypt parameters/limits, no password on role actions. Preserve CLI explicit provider and absolute SQLite path requirements.
- [x] Wire bootstrap after migration before runtime ready. Update shared HTTP session projection to include role without leaking internal credentials. Add uncached server-only superadmin guards and safe FORBIDDEN handling. Adapt existing synthetic account fixtures and expected projections to required role field.

```ts
const identity = await access.requireSuperAdmin(request)
assert.equal(identity.account.role, "superadmin")
await auth.maintain({ action: "revoke-admin", username: "synthetic-admin", actor: "synthetic-operator" })
await assert.rejects(access.requireSuperAdmin(request), { code: "UNAUTHENTICATED" })
```

- [x] Test anonymous/member/forged/expired/disabled/logged-out/DB-failure cases, live role reads, all-session revoke, reset preserves role, enable does not restore old sessions, actual CLI grant/revoke on a synthetic isolated library database, bootstrap config failure before ready. Cover ordinary login/session wire roles and retain all preexisting HTTP protections.
- [x] Document optional paired secret configuration, removal after provisioning, no automatic overwrites, private grant/revoke and password-reset recovery. State that project authorization and anonymous resources remain separate.
- [x] Run focused auth/database/client tests, `pnpm check`, `pnpm test`, `pnpm build`, production start/smoke and `git diff --check`; report actual results and missing environments.
- [x] Produce task report and diff package, independent spec/quality review, repair confirmed findings, then whole-change final review. Keep progress in ignored plan-specific ledger.
