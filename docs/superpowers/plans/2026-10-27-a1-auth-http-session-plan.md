# A1 认证 HTTP、登录与会话生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 执行说明：本次仅编写计划。执行时采用当前可用的对应技能；不存在的技能不可声称已调用。不得自动提交、推送、创建 Issue 或部署。下列提交名称仅为获授权后的建议。

**Goal:** 在既有认证核心上完成 SQLite 下可验证的登录 HTTP、独立 cookie、可撤销身份、运行初始化及有界清理，为丙交付可复用身份入口。

**Architecture:** 保留 Next.js 单应用和 AuthService。先将数据库连接持有从匿名文档服务中抽到显式调用的共享入口，再分别维护业务与匿名资料 ready 守卫。认证服务负责持久化限流、会话和身份重验；可注入的 HTTP handlers 负责输入、Origin、cookie 和安全响应，Route Handlers 仅接线。

**Tech Stack:** Node.js 24、TypeScript、Next.js App Router、pnpm 11.6.0、node:sqlite / gaussdb-node、Node.js test runner + tsx、shadcn/ui login-01。

## Global Constraints

- 本计划拥有实施顺序，不拥有业务规则；规则见 `spec/01-product.md` §3—3.2、`spec/02-workbench-ui.md` §5.1—5.2、`spec/04-database-deployment.md`「业务 schema 迁移」「A1 认证运行生命周期与清理」。
- 当前分支 `alaaladaka/a1-auth-spec`；保留工作区现有修改与未跟踪文件，不把其他计划纳入本包。
- 使用 Node.js 24 和 `package.json` 固定的 pnpm；不新增认证框架、独立 API、Worker、Redis 或公众账号维护接口。
- 密码派生沿用 scrypt 固定参数；“单进程同时最多一个密码派生、七个等待请求”。不通过并行测试扩大资源上限。
- “有效期固定 12 小时，不因访问续期”；“每规范账号 15 分钟最多 5 次、每可信来源 15 分钟最多 30 次”。
- A1 使用服务端固定部署来源桶，忽略客户端 IP/转发头；来源占位先独立提交，账号额度失败不撤回来源占位。
- 私有响应统一 `private, no-store`，密码、散列、令牌不进日志/截图；生产 cookie 必须 Secure/HttpOnly/SameSite=Lax。
- `server-only` 放服务入口；纯核心和可注入工厂供 Node 测试，不为通过测试删除服务端导入边界。
- 不修改已有迁移 0001，不让导入/构建连接数据库，不把健康检查当认证 ready。
- UI 使用官方 block 和组件；产品界面不写实现状态、预览标签或说明段落。
- 所有验证使用合成账号/资料；只记录实际结果。SQLite、浏览器、真实 HTTPS、GaussDB 和项目权限验收分别记录。

## 文件与责任

以下路径均相对仓库根目录；新增文件只在所属任务开始时建立。

| 文件 | 操作与责任 |
| --- | --- |
| `src/server/database/runtime.ts`、`runtime-core.ts`、`runtime.test.ts` | 新增共享连接入口、可注入连接持有器与其测试 |
| `src/server/documents/service.ts` | 改用共享连接；保留匿名资料 ready 和公开接口 |
| `src/server/auth/service.ts`、`errors.ts`、`service.test.ts` | 扩展限流错误元数据、会话轮换和重验 |
| `src/server/auth/cleanup.ts`、`cleanup.test.ts` | 新增有界认证清理 |
| `src/server/auth/runtime.ts`、`runtime-core.ts`、`runtime.test.ts` | 新增业务 ready、初始化和清理生命周期 |
| `src/instrumentation.ts` | 显式启动业务 runtime，保留现有文档和审查 runner |
| `src/server/database/migrations.ts`、`migrations.test.ts` | 追加清理索引，保护迁移历史 |
| `src/server/auth/config.ts`、`http.ts`、`handlers.ts`、`http.test.ts` | 配置、协议与可注入 handlers；真实路由接线检查也放认证测试目录 |
| `src/server/auth/access.ts`、`index.ts`、`access.test.ts` | server-only 当前身份入口和纯工厂测试 |
| `src/app/api/auth/{login,logout,session}/route.ts` | 三个 Node.js HTTP 薄入口 |
| `src/app/login/page.tsx`、`src/components/auth/login-form.tsx` | 官方 login-01 登录页 |
| `src/lib/auth/{client,login-controller,return-target,session-controller}.ts` 及相邻 `*.test.ts` | 有类型的客户端错误、重复提交、回跳和失效状态 |
| `src/components/auth/account-controls.tsx` | 消费项目工作区提供的离开保护与资源清理回调 |
| `src/components/ui/{card,field}.tsx` | 从官方示例补齐当前缺少的组件；复用既有 Input/Button |
| `scripts/manage-account.mts`、`src/server/auth/maintenance.test.ts` | 显式维护库配置和私有标准输入 |
| `.env.example`、`README.md`、`docs/deployment.md` | 配置、维护与启动故障操作 |
| `package.json` | 将新增 lib/auth 测试加入默认测试命令，不遗漏既有路径 |
| `docs/reviews/2026-10-27-a1-auth-validation.md` | 实际执行时建立；日期改变则使用实施日期 |

## 共享类型与执行顺序

任务顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。任务 6 的登录页可独立验证；项目工作区挂载须取得 C1/C3 真实入口和 A2 保护接点后再验收。

```ts
type Account = { id: string; username: string }
type AuthIdentity = {
  account: Account
  session: { id: string; expiresAt: number }
}
type SessionView = { user: Account; expiresAt: string }
type LoginResult = { token: string; expiresAt: number; user: Account }
```

内部日期统一 epoch 毫秒，HTTP `expiresAt` 转 UTC ISO 8601。`session.id` 为会话摘要，仅服务端保存和重验；客户端只接收 SessionView。这些类型由任务 2 在 `service.ts` 定义并导出，不跨文件复制。

### Task 1：共享连接持有，保留双就绪边界

**Files:** 新增 database/runtime-core.ts、runtime.ts、runtime.test.ts；修改 documents/service.ts。

**Interfaces:**

- Consumes：已有 `connectDatabase(): Promise<Database>`、`DocumentServices`、匿名 `retentionRuntimeReady()`。
- Produces：纯 `createDatabaseHolder(connect: () => Promise<Database>)` 返回 `{ get(): Promise<Database>; close(): Promise<void> }`；server-only `applicationDatabase(): Promise<Database>` 使用进程单例 holder。

- [x] 写连接竞争与失败后显式调用可重试测试；两个调用取得同一 Database，close 等待连接且不重复关闭。代表测试：

```ts
let calls = 0
const holder = createDatabaseHolder(async () => { calls++; return database })
const [first, second] = await Promise.all([holder.get(), holder.get()])
assert.equal(first, second)
assert.equal(calls, 1)
```

测试中的 database 使用可计数的 Database 替身；另用真实 SQLite 验证文档与认证表可在同一连接访问。

- [x] 运行 `pnpm exec tsx --test src/server/database/runtime.test.ts`，确认新导出缺失导致失败。
- [x] 实现 holder 的惰性 get、失败移除缓存和 close；runtime.ts 只创建 holder，导入不调用 get。document service 的 createDocumentServices 改为 `await applicationDatabase()`，不改 documentServices 的匿名 ready 等待，不让文档调用关闭公共连接。

```ts
const state = globalThis as typeof globalThis & {
  equilensDatabaseHolder?: ReturnType<typeof createDatabaseHolder>
}
export function applicationDatabase() {
  state.equilensDatabaseHolder ??= createDatabaseHolder(connectDatabase)
  return state.equilensDatabaseHolder.get()
}
```

- [x] 运行 `pnpm exec tsx --test src/server/database/*.test.ts src/server/documents/*.test.ts`；验证原文档版本、删除重放失败守卫和匿名任务数据库入口无回归。
- [x] 审查 diff，只保留连接所有权所必需的改动。建议提交名：`refactor: share explicit database runtime`。

### Task 2：来源额度、可撤销身份与会话轮换

**Files:** 修改 auth/service.ts、errors.ts、service.test.ts；沿用 password.ts 的固定参数和队列。

**Interfaces:**

- Consumes：共享 Database、注入时钟及既有 maintain/current/logout 调用。
- Produces：保留 `current(token): Promise<Account | null>` 的既有语义；新增 `session(token): Promise<AuthIdentity | null>`、`revalidateSession(sessionId): Promise<AuthIdentity | null>`；`login(username, password, source, previousToken?: string): Promise<LoginResult>`。
- `AuthError` 增加 HTTP 所需错误码及可选 `retryAfterSeconds: number`；不得把内部错误对象直接序列化。

- [x] 写反例：非法账号仍占来源、账号超限仍占来源、第 31 次来源拒绝；窗口结束恢复，重开库不重置。代表测试沿用现有 setup：

```ts
for (let n = 0; n < 30; n++) {
  await assert.rejects(auth.login("!", password, "deployment"), {
    code: "INVALID_CREDENTIALS",
  })
}
await assert.rejects(auth.login("operator", password, "deployment"), {
  code: "LOGIN_RATE_LIMITED",
})
```

- [x] 运行 `pnpm exec tsx --test src/server/auth/service.test.ts`，确认来源反例失败。
- [x] 先独立事务原子占来源，再规范账号并占账号；账号占位失败不能回滚来源。长度越界在正文结构及来源保护后返回安全输入错误，不分配派生内存。修改 reserve 使其在事务内返回限流结果，事务提交后抛含剩余秒数的 AuthError；SQL 使用现有 SELECT/条件 UPDATE，不引入未经验证的 RETURNING。
- [x] 为首次插入及窗口替换竞争使用唯一约束和条件写；遇唯一冲突后重新读取/判定一次，仍冲突安全失败，不无限重试。不得将数据库故障误认限流。
- [x] 成功签发与删除 previousToken 对应旧行放同一事务；保留凭据 revision/启用状态守卫，核验失败不撤销旧会话。session 与 revalidateSession 共用数据库有效性查询，拒绝过期、停用或已撤销引用。

```ts
const first = await auth.login("operator", password, "device-one")
const other = await auth.login("operator", password, "device-two")
const next = await auth.login("operator", password, "device-one", first.token)
assert.equal(await auth.current(first.token), null)
assert.ok(await auth.current(other.token))
assert.ok(await auth.current(next.token))
```

- [x] 补并发、到期边界、会话引用不可复活、重置/停用竞争测试。现有测试按“第几个事务”注入停用，改为在读取到 password_hash 后至签发前触发，避免限流拆事务导致测试失真。不要以墙钟延时比较证明密码核验等时。
- [x] 运行 `pnpm exec tsx --test src/server/auth/service.test.ts src/server/auth/password.test.ts`。建议提交名：`feat: complete revocable authentication sessions`。

### Task 3：有界清理、迁移及业务 runtime

**Files:** 新增 auth/config.ts、cleanup.ts、cleanup.test.ts、runtime-core.ts、runtime.ts、runtime.test.ts；修改 instrumentation.ts、database/migrations.ts、migrations.test.ts。

**Interfaces:**

- Consumes：`applicationDatabase()`、`migrateBusiness(db)`、任务 2 的 AuthService。
- Produces：`authConfig(env: Record<string, string | undefined>): { origin: string; secure: boolean; cookieName: string; source: string }`；生产 HTTPS、仅开发回环 HTTP，固定 source=deployment，缺失或非法配置抛 AUTH_UNAVAILABLE。配置反例放 runtime.test.ts，HTTP 属性在任务 4 补测。
- Produces：`cleanExpiredAuth(db: Database, now: () => number): Promise<{ sessions: number; limits: number; batches: number }>`。
- 纯 `createAuthRuntime({ initialize, sweep, schedule })`：initialize 返回 `Promise<AuthService>`；sweep 返回 Promise<void>；schedule 接收 tick 和间隔毫秒，返回取消函数；返回 `{ start(): void; stop(): Promise<void>; get(): AuthService }`。
- server-only runtime.ts 导出 `startAuthRuntime()`、`stopAuthRuntime()`、`authServices(): AuthService`，get 未就绪立即抛 AUTH_UNAVAILABLE，不挂起请求。

- [x] 在清理测试种入 1001 条到期会话、1001 条旧限流和有效对照行，验证首次只删各 1000 条、下一轮删剩余，保留账号/审计及有效行：

```ts
const first = await cleanExpiredAuth(db, () => cutoff)
assert.deepEqual(first, { sessions: 1000, limits: 1000, batches: 10 })
const second = await cleanExpiredAuth(db, () => cutoff)
assert.equal(second.sessions, 1)
assert.equal(second.limits, 1)
```

使用 fixture helper 批量插入，附 cutoff 恰好到期、窗口刷新条件删除、失败回滚测试。

- [x] 运行 `pnpm exec tsx --test src/server/auth/cleanup.test.ts src/server/auth/runtime.test.ts`，确认缺失工厂失败。
- [x] 清理每轮固定 cutoff，每事务 SELECT ORDER BY 主键 LIMIT 100 后逐行条件删除；会话匹配 token_hash/expires_at，限流匹配 limit_key/window_start。最多 10 个事务，空批停止；窗口查询使用 `window_start <= cutoff - 900000`。
- [x] 追加下一空闲迁移编号，增加 expires_at/window_start 索引。执行前重查其他人是否已占用 0002，不能修改 0001 或覆盖他人编号；修改迁移测试中“固定只有一项”的预期为完整当前账本，同时保留历史摘要检测。
- [x] 先实现 config.ts 的配置解析及上述失败条件，再实现 runtime 的显式 idle/starting/ready/failed/stopped 状态，重复 start 共用初始化；失败只允许显式 start 重试。初始化检查 auth 配置后取得公共连接并 migrateBusiness，再开放 ready 和每小时非重叠清理；timer unref，失败仅输出固定消息，stop 等待启动和 sweep，不关闭共享数据库。
- [x] instrumentation 的现有 Node/build 守卫内启动 auth runtime；auth 启动不等待匿名 retention ready，项目资料访问仍需自身恢复屏障。验证导入不启动、构建不连接、失败不使 healthz 失效、stop 后不会开放 ready 或重新注册 timer。
- [x] 运行 `pnpm exec tsx --test src/server/auth/cleanup.test.ts src/server/auth/runtime.test.ts src/server/database/*.test.ts src/server/documents/*.test.ts`。建议提交名：`feat: initialize and clean authentication state`。

### Task 4：HTTP 协议、cookie 与真实路由

**Files:** 新增 auth/handlers.ts、http.test.ts 和三个 api/auth 路由；修改 auth/config.ts、http.ts、errors.ts。

**Interfaces:**

- Consumes：`authServices()`、`AuthService.login/session/logout`、任务 3 的 `authConfig(env)`。
- `createAuthHandlers({ services, config, now })` 返回 `login(request): Promise<Response>`、`session(request): Promise<Response>`、`logout(request): Promise<Response>`；services 为同步 AuthService getter，config 返回上述配置，now 返回 epoch 毫秒。
- http.ts 保留既有 assertAuthOrigin，对外新增 `readAuthCookie(request, cookieName): string | null`；重复同名 cookie 视为非法，不随意选一个。

- [x] 写无 Origin/错误 Origin、缺配置、错误 Content-Type、分块超过 4 KiB、额外字段测试；断言未进入 service。成功错误响应均检查 no-store。代表测试使用 spy services：

```ts
const response = await handlers.login(new Request("https://equilens.example/api/auth/login", {
  method: "POST", headers: { Origin: "https://evil.example" }, body: "{}",
}))
assert.equal(response.status, 403)
assert.equal(response.headers.get("cache-control"), "private, no-store")
assert.equal(serviceCalls, 0)
```

- [x] 运行 `pnpm exec tsx --test src/server/auth/http.test.ts`，确认缺 handlers 导出失败。
- [x] 配置仅开发回环允许 HTTP，生产拒绝非 HTTPS 和非法 URL；source 固定 `deployment`，不读取转发头。配置错误 503，合法配置下错误 Origin 403。GET session 也检查配置及 ready，不依赖 Origin。
- [x] 登录使用 Request.body reader 计实际字节、超过限制取消读取并 413，严格 JSON 白名单。处理所有规格错误码，未知异常统一 AUTH_UNAVAILABLE；Retry-After 使用任务 2 返回秒数，不重新启动 15 分钟窗口。
- [x] 登录用当前 cookie 作为 previousToken；响应仅 SessionView，Set-Cookie 的 Max-Age 向下取整且不超过 expiresAt-now。GET 不签新 cookie，未认证清除失效 cookie；logout 校验无正文、同源及数据库撤销成功后才清 cookie。重复退出仍 204；数据库失败 503，不能假退出。
- [x] 路由只导入 server-only 入口和 handlers，各导出 runtime=nodejs、dynamic=force-dynamic 及对应 GET/POST。工厂不依赖 Next cookies 全局，方便 Request/Response 集成测试。
- [x] 增加生产/开发 cookie 名隔离、固定有效期、无 Domain、失败不发 token、session query 身份注入拒绝、伪造头不改变限流、错误脱敏测试；在启动应用后用真实 URL 验证三个路由接线，不只测工厂。
- [x] 运行 `pnpm exec tsx --test src/server/auth/*.test.ts src/server/database/migrations.test.ts`。建议提交名：`feat: expose controlled authentication routes`。

### Task 5：交付可重验的身份入口

**Files:** 新增 auth/access.ts、access.test.ts；修改 auth/index.ts。

**Interfaces:**

- Consumes：任务 2 的 AuthIdentity 和 revalidateSession、任务 4 的 config/readAuthCookie。
- Produces：可注入 `createAccountAccess({ services, config })`，返回 `requireAccount(request): Promise<AuthIdentity>`、`revalidateAccountSession(sessionId): Promise<AuthIdentity>`；纯工厂置于 handlers.ts，server-only access.ts 绑定真实依赖并由 index.ts 导出两个函数和身份类型。

- [x] 写 cookie 身份验证、缺失/格式错误/撤销/到期拒绝、数据库故障 503 测试；同一 Request 对象第二次调用也须重查数据库：

```ts
const identity = await access.requireAccount(request)
await auth.logout(token)
await assert.rejects(access.requireAccount(request), { code: "UNAUTHENTICATED" })
await assert.rejects(access.revalidateAccountSession(identity.session.id), {
  code: "UNAUTHENTICATED",
})
```

- [x] 运行 `pnpm exec tsx --test src/server/auth/access.test.ts`，确认缺失工厂失败。
- [x] 实现入口只读 cookie，不读 accountId、角色 header、query token；数据库错误不转换为 401。不返回项目角色；服务端摘要重验只允许内部参数，HTTP 不接受 session.id 当令牌。
- [ ] 与丙核对 C0 调用方式：成员守卫接收完整 AuthIdentity，在同一项目操作再次校验 session.id 和成员关系；长任务持久化必要引用，每阶段重验。明确退出会话将阻止该会话任务后续外发，不能只查账号启用状态。
- [x] 用合成消费者测试“身份检查后撤销，项目操作前重验拒绝”；实际项目角色/跨项目下载留给 C1/C3 联验，不在 auth 中构造假项目仓储。
- [x] 运行 `pnpm exec tsx --test src/server/auth/*.test.ts`。建议提交名：`feat: provide revalidated server account access`。

### Task 6：官方登录页、回跳与退出保护接点

**Files:** 新增文件映射中的 login 页面、auth 组件、lib/auth 模块及相邻测试；补 card/field；修改 package.json。

**Interfaces:**

- Consumes：三个 auth HTTP 入口及 SessionView；A2/C1/C3 提供真实项目工作区宿主。
- Produces：`safeReturnTarget(value: string | null, origin: string): string`；`createLoginController({ submit, onSuccess })` 返回 `{ run(username, password): Promise<void>; pending(): boolean }`，submit 返回 Promise<SessionView>，onSuccess 接收 SessionView。
- `createSessionController({ check, leave, logout, clear, navigate })` 返回 `{ refresh(): Promise<void>; exit(): Promise<void> }`；check 返回 Promise<SessionView>，leave 返回 Promise<boolean>（全部保存/明确放弃才 true），logout 返回 Promise<void>，clear 无返回，navigate 接收站内路径。
- `AccountControls` 接收上述 controller 与当前用户名；不自行建立项目权限或另写一套未保存登记器。

- [x] 为回跳与控制器写行为测试：重复 run 仅一次 submit；拒绝后允许显式重试；取消 leave 不发 logout；logout 失败不导航、不宣称退出；401 立即 clear，网络失败显示错误而不当作会话撤销。回跳样例：

```ts
for (const input of ["https://evil.example", "//evil.example", "/\\evil.example", "%2f%2fevil.example"]) {
  assert.equal(safeReturnTarget(input, "https://equilens.example"), "/")
}
assert.equal(safeReturnTarget("/?document=one", "https://equilens.example"), "/?document=one")
```

- [x] 运行 `pnpm exec tsx --test src/lib/auth/*.test.ts`，确认缺失导出失败。
- [x] 回跳仅接受 `/` 开始的站内路径，限制原始和解码后控制符/反斜杠/双斜杠/协议；解析后再次比对 origin，非法回 `/`。不在登录页绕过目标服务端授权。
- [x] 阅读并采用官方 [login-01 页面](https://ui.shadcn.com/blocks/login#login-01)和[表单源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/blocks/login-01/components/login-form.tsx)，补齐官方 Card/Field 依赖。保留布局和变体，按 UI §5.1 只做账号字段及移除未支持入口的偏离；记录来源和偏离，不添加自定义 CSS。
- [x] 登录组件用 ref/控制器同步锁阻止 Enter/点击并发；finally 清空密码，保留账号；显示安全错误、aria-busy、aria-describedby。客户端不存 token、密码或身份到 localStorage；fetch 禁止缓存，网络异常不自动重试。
- [x] 实现 session controller 的聚焦/导航复查和主动退出流程；clear 同时取消受保护请求、移除数据视图和撤销对象 URL，旧请求完成用 generation 检查阻止重填。失效后隔离未保存内存输入，禁用保存/复制/下载；重登不自动提交。
- [x] 将 lib/auth/*.test.ts 纳入 pnpm test。运行 `pnpm exec tsx --test src/lib/auth/*.test.ts` 和 `pnpm check`；浏览器验证键盘提交、密码清空、错误读出、窄屏和回跳，保留合成截图。
- [ ] 在 C1/C3 的真实项目工作区挂载 AccountControls；A2 leave 回调验证保存失败留原地、取消不退出、保存成功项不重建版本。无项目只显示“暂无项目”，不创建假项目或假成功页；C1/C3 未交付时记录该联验未运行，保留匿名首页原有契约，不把匿名首页改成项目工作区。
- [x] 建议提交名：`feat: add controlled login and session controls`。登录页与工作区联验分别记状态，不能合并宣称 UI-14/15 通过。

### Task 7：私有维护入口与操作说明

**Files:** 修改 scripts/manage-account.mts、auth/maintenance.test.ts、.env.example、README.md、docs/deployment.md。

**Interfaces:**

- Consumes：既有 `pnpm account:maintain <action> --username <name> --actor <operator>`、私有 stdin 及 DATABASE_PROVIDER/SQLITE_PATH。
- Produces：相同命令签名；缺明确 provider 或 SQLite 绝对路径时拒绝，成功/失败均不输出秘密。

- [x] 扩展现有 CLI subprocess 测试，移除 .env.local 对测试环境的干扰，覆盖缺 provider、未知 provider、缺路径、相对路径、参数携带密码、重复账号、停用/重置旧会话失效。代表断言：

```ts
assert.notEqual(await runWithEnv({ DATABASE_PROVIDER: "sqlite", SQLITE_PATH: "relative.sqlite" }), 0)
assert.equal(output.includes(password), false)
```

runWithEnv 在 maintenance.test.ts 中封装现有 spawn，传入完整隔离 env、合成 stdin，收集退出码和脱敏输出；不把真实密码放测试命令参数。

- [x] 运行 `pnpm exec tsx --test src/server/auth/maintenance.test.ts`，确认当前接受相对路径的反例失败。
- [x] 加载环境后显式检查 provider，SQLite 使用 isAbsolute 验证，失败早于连接。保留隐藏输入/私有标准输入边界，不新增密码参数或 HTTP 接口。
- [x] 更新 .env.example：开发 APP_ORIGIN=http://127.0.0.1:3000，生产示例 HTTPS；使用不同 localhost origin 时必须同步配置。说明共享来源 30 次/15 分钟可能限制不同用户，不称为按 IP 限流。
- [x] README 与部署指南补私有 stdin 的进程调用步骤、选库、停用/重置验证、认证未就绪 503 的诊断与显式重启；禁止把密码字面量写 shell 历史。不修改镜像发布行为。
- [x] 运行 `pnpm exec tsx --test src/server/auth/maintenance.test.ts`。建议提交名：`docs: document controlled account operations`。

### Task 8：回归、证据与下游签收

**Files:** 新建实施日期的 docs/reviews/*-a1-auth-validation.md；更新 spec/README.md 和 README.md 的实际状态，不能把计划写成通过结果。

**Interfaces:** 消费 AUTH-01—07 的实际输出、A2/C1/C3/A5 联验结果；交付可追溯证据与剩余缺项。

- [x] 依次执行定向检查，再顺序执行全量检查；每项记录退出码、Node/pnpm 版本、当前提交及未提交 diff 摘要，失败修复后只重跑受影响项，最终全量命令记录对应同一版本。

```text
pnpm exec tsx --test src/server/auth/*.test.ts src/server/database/migrations.test.ts
pnpm exec tsx --test src/lib/auth/*.test.ts
pnpm check
pnpm test
pnpm build
git diff --check
```

- [x] 在隔离合成库启动生产构建，运行 `pnpm start`，就绪后执行 `pnpm smoke http://127.0.0.1:3000`。生产 Secure cookie 浏览器验收须使用有效 HTTPS 测试入口；HTTP 回环仅用于开发 cookie 验证，不冒充生产 cookie 验收。
- [x] 使用真实 Route Handler 做登录→session→退出→session=401 闭环，核对无 Origin 写拒绝、严格回跳、重复 cookie、Set-Cookie 属性与 no-store；证据不记录 cookie/header 明文。
- [x] 浏览器记录登录成功/错误、重复提交、网络失败、退出、到期/停用、重新启用仍拒旧会话；模拟时钟只能支持逻辑结果，浏览器到期须说明采用隔离测试环境的过期会话，不能改正式 12 小时契约。
- [ ] 验证未登录项目材料拒绝、无项目空集合、三角色与撤权、旧页签聚焦、下载/另存旁路及未保存退出；由 A2/C1/C3 分别提供真实接点，缺任一项标记“未运行：依赖未交付”，不以假仓储或匿名 cookie 替代。
- [ ] 真实 GaussDB、有效 HTTPS、Linux 容器及权限联验分别列环境和原始脱敏输出；无环境记录“未运行”，不补造结果、不自动部署。
- [ ] 丙审查认证与身份消费，乙核对业务不会将认证成功误作项目授权；记录实际审查结论和签收版本。任何未通过项仍保留，A1 本地完成不能单独勾选 AC-01/AC-15。
- [ ] 建议提交名：`docs: record A1 authentication validation`；提交、推送及外部发布仍需当次用户授权。

## 规格覆盖与完成门槛

| 规格/验收 | 实施任务 | 完成证据 |
| --- | --- | --- |
| AUTH-01 HTTP/Origin/正文/错误 | 4、8 | 工厂反例 + 实际路由请求 |
| AUTH-02 固定会话与 cookie | 2、4、8 | SQLite 会话轮换 + 浏览器属性与退出 |
| AUTH-03 凭据与撤销竞争 | 2、7、8 | 竞争测试 + 停用/重置操作 |
| AUTH-04 可信来源与持久限流 | 2、4、7 | 非法账号/并发/伪造头/重开库 |
| AUTH-05 身份与项目交接 | 5、8 | 会话摘要重验 + C1/C3 联验 |
| AUTH-06 登录与未保存保护 | 6、8 | 浏览器 + A2/C1/C3 工作区联验 |
| AUTH-07 生命周期/清理/维护 | 1、3、7、8 | 初始化状态、清理边界、选库测试 |
| 匿名文档及审查无回归 | 1、3、8 | 文档、审查任务与全量回归 |

计划完成不代表实施完成。交付分别标识“本地已实现待验收”“联验通过”“外部缺项”，不使用单一勾选掩盖下游未接通；工程测试不计入 24/60 个法律业务样本。

## 自审记录（计划阶段）

- 已按 AUTH-01—07 逐项映射实施任务，未另建与拥有规格重复的认证规则。
- 已保留 current() 既有返回值，新增 session() 供元数据消费；HTTP 日期与内部时钟类型区分明确。
- 已拆开连接持有、匿名 ready、业务 ready，防止认证初始化等待匿名保留配置或删除日志；项目资料访问仍保留恢复屏障。
- 已将现有限流事务回滚问题和事务序号注入测试问题纳入任务 2；迁移编号在执行前与其他工作包核对。
- A2/C1/C3 的资源保护联验、有效 HTTPS 与 GaussDB 均有明确门槛，未声称现有代码已具备。
- 本次未执行本计划列出的功能测试、构建或浏览器操作；仅对计划文件进行静态检查。

## 2026-10-27 执行状态

Tasks 1—7 已交付本地实现并经过独立代码审查；Task 8 的实际 SQLite HTTP 闭环发现并修复跨 bundle runtime 和错误身份问题，同时补齐 405/OPTIONS no-store。工程检查及未运行项见 [A1 验证记录](../../reviews/2026-10-27-a1-auth-validation.md)。2026-10-28 续验：无观察 preload 的默认生产构建、该精确产物生产启动/冒烟、本地自签 TLS 浏览器登录交互均已通过；项目权限、A2 未保存对象接点、有效公网 HTTPS/GaussDB/Linux/CI/外部签收均未完成。早期 CSS worker 失败证据保留，不将后续成功归因于未证实的唯一原因。上述本地进展不勾选联合验收闸门，也不代表 AC-01/AC-15 通过。

2026-10-28 独立整体验收代码审查已通过，本地实现范围无遗留审查问题。上述未运行的联合验收继续保留；本次未提交、推送或部署。
