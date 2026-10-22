# 步骤一配套：匿名资料保留实施计划

> **For agentic workers:** 按任务逐项执行；用户明确授权委派时使用 `subagent-driven-development`，否则顺序执行。本文只规划已接受的 DB-08，不授权清理真实数据、提交或部署。

**Goal:** 为步骤一提供真实的保留期限、访问守卫、迁移导出窗口、到期清理和新会话能力，通过 DB-08。

**Architecture:** 在现有数据库适配器中迁移到 schema v2，保留不可变文档与版本；增加按匿名 owner 登记的期限记录。所有文档操作在服务端检查期限；清理由同一 Node.js 应用显式生命周期启动，删除意图保留在独立于数据库备份的持久私有日志中，恢复前重放。

**Tech Stack:** Node.js 24 `node:sqlite` / 现有 `gaussdb-node` 适配、Next.js Node Route Handlers、TypeScript、esbuild、Node.js test runner + tsx；不加 ORM、队列服务、定时任务平台或云服务。

## Global Constraints

- 所属契约：[数据库规格](../../../spec/04-database-deployment.md)“匿名资料的保留与清理”及 DB-08；[产品 §10.5](../../../spec/01-product.md#105-材料授权隐私与清理)负责备份、删除和恢复的共同底线。
- “`ANONYMOUS_DATA_RETENTION_DAYS`，值为正整数天数，无默认值。”实际天数、用途和存量窗口由负责人登记，计划及夹具不替其选择。
- “同一匿名会话以最早文档创建时刻加登记天数计算并持久化固定到期日及策略版本。”读取、保存、新建、导入或复制不续期。
- “构建和健康检查不因该配置连接数据库或启动清理。”不能在模块导入、React 渲染或请求健康接口时启动清理。
- 到期立即拒读写；物理清理的“默认在到期后 24 小时内”目标不等于允许继续访问 24 小时。
- 存量有登记且已通知的导出窗口，窗口内仅原会话可读/导出；窗口结束拒读写。不得推测存量已同意立即删除。
- SQLite 单实例、持久卷、短事务；GaussDB 真机/版本/模式独立验证，不能将 SQLite 通过扩大为 GaussDB 通过。
- 项目独立副本不属于匿名清理范围；本步不实现业务项目、OBS 或全项目备份平台。
- 当前脚本会把所有 409 当作保存冲突，须一起改为按错误码区分；所有 POST/PUT 保持同源检查。
- 本计划的表名、接口和 CLI 细节在 S1 执行时先写入拥有契约的 `spec/04-database-deployment.md`，再实现，避免计划成为平行契约。

---

## 文件职责与依赖

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/lib/documents/session-types.ts` | 新建 | 安全的线协议类型，不含 cookie 原值、数据库客户端或凭据 |
| `src/server/documents/retention-policy.ts`、`retention-policy.test.ts` | 新建 | 纯函数配置解析、到期计算、访问状态 |
| `src/server/database/connection.ts` | 修改 | 初始 v2 / v1→v2 迁移，保持适配器和未知版本拒绝 |
| `src/server/documents/session-repository.ts`、`session-repository.test.ts` | 新建 | 会话登记、固定期限、迁移标记和事务内守卫 |
| `src/server/documents/repository.ts`、`repository.test.ts` | 修改 | 所有 list/open/create/save/copy 经过期限守卫 |
| `src/server/documents/service.ts`、`http.ts`、`http.test.ts` | 修改 | 生命周期就绪、身份上下文、错误码和 HTTP 准入 |
| `src/app/api/document-session/route.ts`、`src/server/documents/session-http.test.ts` | 新建 | 查询与显式重开会话的薄 HTTP 入口及测试 |
| `src/app/api/documents/route.ts`、`src/app/api/documents/[id]/route.ts` | 修改 | 当前上下文、期限确认、到期后不返回资料 |
| `src/lib/documents/client.ts`、`session-client.test.ts` | 修改/新建 | 会话客户端、错误区分、取消与上下文隔离 |
| `src/server/documents/retention-cleanup.ts`、`retention-cleanup.test.ts` | 新建 | 删除意图日志、清理/恢复和单进程生命周期 |
| `src/instrumentation.ts` | 新建 | 只在显式 Node.js 服务生命周期调用运行函数 |
| `scripts/anonymous-retention.mts`、`scripts/build-retention-tools.mjs` | 新建 | 运维检查/登记/重放 CLI，打包进现有 generated 目录 |
| `package.json`、`.env.example`、`compose.yaml`、`zeabur-template.yaml` | 修改 | 实际生效的配置及工具构建；不设置生产保留默认值 |
| `scripts/smoke-database.mjs`、`.github/workflows/ci.yml` | 修改 | 期限确认与隔离卷测试参数，不改变发布条件 |
| `README.md`、`DEVELOPMENT.md`、`docs/deployment.md` | 修改 | 用途/天数/通知/迁移登记、备份日志及恢复次序 |

依赖顺序：S1 → S2 → S3；S4 与 S5 消费 S2/S3 的数据契约；S6 汇总。主计划任务 1—2 可先行，
任务 3 在 S1 类型完成后接入取消参数，任务 4 在 S3 服务可用后联调；完整交付仍须 S4—S6。

## S1：配置、访问状态与线协议

**Files:** 新建 `session-types.ts`、`retention-policy.ts`、`retention-policy.test.ts`；修改 `spec/04-database-deployment.md` 的接口细节。

**Consumes:** 既有 owner 哈希和文档 UTC 时间；**Produces:** 主计划与后续任务共同使用的下列确定类型：

```ts
export type RetentionConsent = {
  contextId: string
  policyVersion: string
  expiresOn: string // 服务端给出的 Asia/Shanghai 日期，YYYY-MM-DD
}

export type DocumentSessionCode =
  | "RETENTION_UNCONFIGURED" | "RETENTION_EXPIRED" | "LEGACY_RETENTION_PENDING"
  | "SESSION_CONTEXT_REQUIRED" | "SESSION_CHANGED"
  | "RETENTION_CONSENT_REQUIRED" | "RETENTION_CONFIRMATION_CHANGED"
  | "RETENTION_READ_ONLY" | "SESSION_RESTART_NOT_ALLOWED"

export type AnonymousSessionView = {
  contextId: string // 独立随机展示标识，不能用于替代 cookie 授权
  state: "new" | "active" | "legacy_export" | "expired" | "legacy_pending"
  expiresAt: string | null
  exportUntil: string | null
  canRead: boolean
  canCreate: boolean
  canSave: boolean
  canRestart: boolean
  confirmation: RetentionConsent | null
  issue?: { code: DocumentSessionCode; message: string }
}

export type StoredAnonymousSession = {
  owner: string
  contextId: string
  firstCreatedAt: string | null
  retentionDays: number | null
  expiresAt: string | null
  policyVersion: string | null
  exportUntil: string | null
  legacyPending: boolean
  revision: number
  revokedAt: string | null
  registration: string | null // 存量登记 JSON 原文，仅审计与重放核对
}

export type RetentionPolicy = { days: number; version: string }
export function retentionPolicy(env?: Record<string, string | undefined>): RetentionPolicy
export function retentionExpiry(firstCreatedAt: string, days: number): string
export function sessionAccess(record: StoredAnonymousSession, now: Date,
  currentPolicy: RetentionPolicy | null): AnonymousSessionView
```

`RetentionConsent`、`DocumentSessionCode`、`AnonymousSessionView` 放共享文件；`StoredAnonymousSession` 与 policy 函数放服务端纯模块。
会话状态优先级：已存在 revokedAt 或删除已重放 → expired；存量未登记 → legacy_pending；
存在到期日且已过期、导出窗口未结束 → legacy_export；存在到期日且已过期（含导出窗口已结束或本无窗口）→ expired；
否则按是否有 firstCreatedAt 为 new/active。窗口结束必须回到 expired，不得落回 new/active。
配置缺失时禁止 create/copy，但既有有效登记可继续其合法 read/save；窗口仅允许 read/download，
expired 仅在配置有效时允许 restart。

guardIn 动词语义固定为：read 覆盖列表与版本读取，download 覆盖以下载形式取得已保存版本的同一份字节；
legacy_export 仅允许 read/download（客户端不得挂载编辑器），拒绝 save/create/copy；expired/revoked 全部拒绝。
readPolicy 在缺配置时返回 null：create/copy 拒绝并返回 `RETENTION_UNCONFIGURED`，既有有效登记继续 read/save/download；
readPolicy 抛出的其他异常按数据库故障处理（DB-04），不得冒充配置缺失。

- [ ] **S1.1 先补拥有规格的接口表。**保持业务行为不变，将以下请求/响应、错误码和确认规则写入数据库规格，然后再编写实现：

| 接口 | 请求 | 响应/条件 |
| --- | --- | --- |
| GET `/api/document-session` | 当前 HttpOnly cookie，可取消 | 200 `AnonymousSessionView`；无 cookie 签发新身份，数据库只保存哈希；私有 no-store |
| POST `/api/document-session` | 同源、JSON `{ action: "restart", expectedContextId }` | 仅 expired 可成功；200 新 view + 新 cookie，旧 owner 期限/删除记录不变 |
| GET 文档列表/版本 | cookie + `X-Document-Context` | 保留现有数组/文档响应形状；仅合法 read；相同 header 随响应返回 |
| POST 文档 | 现有字段 + `retentionConsent`，以及上下文 header | authored/imported 必须确认；active 的 copy 沿用已确认固定期限，仍检查配置及复制来源 |
| PUT 文档 | 现有保存字段 + 上下文 header | 合法 save、基础版本及 operationId 规则均保持 |

错误 JSON 为 `{ error, code, session? }`：配置/存量未登记 503，到期 410，上下文缺失 400、变化 409，
缺少确认 422、确认过期 409、窗口内写入 403 RETENTION_READ_ONLY、非到期重开 409 SESSION_RESTART_NOT_ALLOWED；
原保存冲突使用 code=`REVISION_CONFLICT`。不返回 SQL、owner 哈希或 cookie 原值。

- [ ] **S1.2 明确首次创建确认的时间边界。**new 会话尚未创建资料时 `expiresAt=null`，confirmation 显示服务端按当前提交候选时刻计算的日期；首次事务用真实创建时刻固定到期日。若提交时产生的北京时间到期日期或 policyVersion 与用户所确认不同，事务在写资料前返回 `RETENTION_CONFIRMATION_CHANGED`，重新取得确认，不伪造创建时间。active 会话使用已登记的固定到期日。
- [ ] **S1.3 写无默认配置及时间边界测试。**测试值 2 天仅为夹具：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { retentionPolicy, retentionExpiry } from "./retention-policy"

test("DB-08: retention requires a positive integer and has no fallback", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "Infinity", " 2 "]) {
    assert.throws(() => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: value }))
  }
  assert.equal(retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }).days, 2)
  assert.equal(retentionExpiry("2026-10-22T00:00:00Z", 2), "2026-10-24T00:00:00.000Z")
})
```

- [ ] **S1.4 运行红灯，实施纯函数。**执行 `pnpm exec tsx --test src/server/documents/retention-policy.test.ts`；配置只接受十进制正整数字符串，不 trim 成合法值、不回退。使用 `Number.isSafeInteger`，并在计算后拒绝 Date 溢出；policyVersion=`anonymous-v1:${days}`。`sessionAccess` 只读取传入 now，不调用实际数据库或 Date.now，不在导入时读取 env。

```ts
export function retentionPolicy(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const raw = env.ANONYMOUS_DATA_RETENTION_DAYS
  if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error("Invalid anonymous retention configuration")
  const days = Number(raw)
  if (!Number.isSafeInteger(days) || !Number.isSafeInteger(days * 86_400_000)) {
    throw new Error("Invalid anonymous retention configuration")
  }
  return { days, version: `anonymous-v1:${days}` }
}
export function retentionExpiry(firstCreatedAt: string, days: number) {
  const date = new Date(Date.parse(firstCreatedAt) + days * 86_400_000)
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid anonymous retention deadline")
  return date.toISOString()
}
```

- [ ] **S1.5 增加状态表测试并验证。**以固定记录分别测试到期前 1ms、恰好到期、窗口结束前 1ms、恰好窗口结束及窗口结束后 1ms；断言窗口内不允许 create/save/copy、仅允许 read/download，恰好到期起 read/download/save/create/copy 全部拒绝，窗口结束后状态必须为 expired 而不是 new/active。更换配置为另一合法天数不得改变记录 expiresAt。运行 policy 测试及 `pnpm check`，建议提交 `feat: define anonymous retention policy`，仅暂存 S1 明确路径。

## S2：schema 迁移、固定期限与事务守卫

**Files:** 修改 `src/server/database/connection.ts`、`src/server/documents/repository.ts`、`service.ts`、`repository.test.ts`；新建 `session-repository.ts`、`session-repository.test.ts`。

**Consumes:** S1 的纯策略、原 `Database/Connection`。**Produces:**

```ts
export type SessionRepositoryOptions = {
  now: () => Date
  readPolicy: () => RetentionPolicy | null // 缺配置返回 null，异常表示数据库/运行故障
}
export class DocumentSessionRepository {
  constructor(database: Database, options: SessionRepositoryOptions)
  view(owner: string): Promise<AnonymousSessionView>
  assertContext(owner: string, contextId: string): Promise<void>
  guardIn(connection: Connection, owner: string,
    action: "read" | "download" | "save" | "create" | "copy"): Promise<StoredAnonymousSession>
  confirmCreateIn(connection: Connection, owner: string, source: DocumentRecord["source"],
    consent: RetentionConsent | undefined): Promise<{ createdAt: string; expiresAt: string }>
  registerLegacy(input: LegacyRetentionRegistration): Promise<void>
  expiredOwners(limit: number): Promise<StoredAnonymousSession[]>
}
export type LegacyRetentionRegistration = {
  owner: string
  retentionDays: number
  exportUntil: string
  notifiedAt: string
  operator: string
  purpose: string
}
```

`DocumentRepository` 改为 `constructor(database: Database, sessions: DocumentSessionRepository)`；不可提供跳过守卫的默认参数。
create 输入新增 `retentionConsent?: RetentionConsent`，其余 public 方法签名保持；跨会话复制仍按原来源检查拒绝。
复制路径即 `create(source: "copy", copiedFrom)`：guardIn 与 confirmCreateIn 由输入 source 推断动作为 copy，
copy 不要求新的 consent，沿用已登记固定期限，且继续验证原版本属于 owner。list 用 read，版本读取/编辑打开用 read，
下载同一字节用 download；同一事务内一个业务动作只结算一个动词，不以客户端声明的用途替代服务端推断。

- [ ] **S2.1 写真实 SQLite 固定期限测试。**测试建在 `session-repository.test.ts`，使用明确的合成时钟和临时目录：

```ts
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { DocumentRepository } from "./repository"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"
import { blankDocx } from "../../lib/documents/docx"

test("DB-08: another document shares the first deadline and expiry blocks access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-retention-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  let current = new Date("2026-10-22T00:00:00Z")
  const sessions = new DocumentSessionRepository(database, {
    now: () => current,
    readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }),
  })
  const repository = new DocumentRepository(database, sessions)
  const owner = createHash("sha256").update("synthetic-session").digest("hex")
  try {
    const firstView = await sessions.view(owner)
    const first = await repository.create(owner, {
      blob: blankDocx(), title: "首份", source: "authored", prompt: "",
      retentionConsent: firstView.confirmation!,
    })
    const deadline = (await sessions.view(owner)).expiresAt
    current = new Date("2026-10-23T00:00:00Z")
    await repository.create(owner, { blob: blankDocx(), title: "第二份", source: "imported", prompt: "",
      retentionConsent: (await sessions.view(owner)).confirmation! })
    assert.equal((await sessions.view(owner)).expiresAt, deadline)
    current = new Date(deadline!)
    await assert.rejects(repository.open(owner, first.document.id), { status: 410 })
    await assert.rejects(repository.list(owner), { status: 410 })
  } finally { await database.close(); await rm(directory, { recursive: true }) }
})
```

- [ ] **S2.2 运行红灯并添加 v2 数据表。**在原版本迁移事务内建立：

```sql
CREATE TABLE IF NOT EXISTS equilens_document_sessions (
  owner VARCHAR(64) PRIMARY KEY,
  context_id VARCHAR(36) NOT NULL,
  first_created_at TEXT,
  retention_days INTEGER,
  expires_at TEXT,
  policy_version VARCHAR(64),
  export_until TEXT,
  legacy_pending INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  revoked_at TEXT,
  registration TEXT
);
CREATE TABLE IF NOT EXISTS equilens_retention_deletions (
  id VARCHAR(36) PRIMARY KEY,
  owner VARCHAR(64) NOT NULL,
  expires_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reason VARCHAR(32) NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS equilens_session_expiry ON equilens_document_sessions(expires_at);
```

空库初始化为 2；v1→v2 只加表及变更 schema 版本，不重写原件、版本或 document metadata；未知版本仍拒绝。
将 `revoked_at` 映射到 S1 的 revokedAt，存在已重放删除记录时优先判 expired，不因迁移窗口恢复访问。
`equilens_retention_deletions.reason` 对应 `DeletionIntent.reason`，`registration` 列映射到 `StoredAnonymousSession.registration`；
日志 JSON 与数据库行保持同一安全字段口径，重放和审计不依赖日志单侧存在。

- [ ] **S2.3 实现 owner 登记。**`view` 对无文档的新 owner 建立空会话、独立 UUID contextId，firstCreatedAt/expiresAt 为 null。
空会话行只含标识、contextId 与登记时刻，不含资料；其行清理并入 S4 轮次（按运维登记窗口清除仍无文档的空行），
窗口由负责人登记，计划不指定默认值，避免无资料会话行无限积累。
对有文档但未登记的旧 owner 标记 legacy_pending，禁止业务请求自行补默认天数或删除；S5 完成通知和登记后才能访问。
重复初始化由 owner 主键约束，竞争插入失败回滚后重新读取，不能创建两套期限；不依赖未经验证的 UPSERT/JSONB。
- [ ] **S2.4 将初始化期限与首份文档放在同一事务。**Blob 编码在事务外；事务内由 confirmCreateIn 取一次 now，
同一创建时刻用于文档、首版本与期限。使用 `revision` 条件更新会话；竞争失败重新读取并检查已确定的期限与 consent，
不能以最后返回者重置期限。更新后的配置只影响新会话，已有记录不隐式续期。
- [ ] **S2.5 在仓储内部保护每个资源操作。**list 用 read、版本读取/下载用 read/download、save/create/copy 用对应动词，
均在同一事务内调用 guardIn；save 同时保留 baseRevision 与 operationId 约束。create/import 配置缺失或 consent 不匹配时不得留下孤立版本；
copy 不创建新会话或新期限，且继续验证原版本属于 owner。legacy_export 允许 read/download（列表与已保存版本的同一份字节，
客户端不得挂载编辑器、不得序列化新内容），其余写操作拒绝；expired/revoked 对全部动词拒绝。
- [ ] **S2.6 更新服务与原测试夹具。**`service.ts` 缓存一个 database + sessions + documents 组合；
`documentRepository()` 继续作为薄兼容入口。默认 clock 为 `() => new Date()`，策略在服务操作时读取，导入不发请求。
原 `repository.test.ts` 注入固定合法策略并对 authored/imported 提供 view.confirmation；保留所有原 DB-01—DB-03 的断言，
失败事务包装器仍向 guardIn 传入同一事务 connection，不通过测试专用绕过开关取消权限。
- [ ] **S2.7 补齐竞争与迁移回归。**测试 v1 原件/历史摘要迁移后不变、未知 schema 拒绝、配置缺失不创建、
首次创建日期跨北京时间午夜返回确认变化且无文档落库、两个首份创建只登记一个期限、copy/save/reopen 不续期。
测试夹具使用本任务真实 SQLite 模式及可变 now；不修改系统时间。
- [ ] **S2.8 验证并保存任务边界。**运行 `pnpm exec tsx --test src/server/documents/retention-policy.test.ts src/server/documents/session-repository.test.ts src/server/documents/repository.test.ts` 及 `pnpm check`，建议提交 `feat: enforce anonymous document deadlines`。真实 GaussDB 迁移/竞争另列实测，不写为已通过。

## S3：真实 HTTP、取消与会话切换

**Files:** 新建 `src/server/documents/handlers.ts`、`session-http.test.ts`、`src/app/api/document-session/route.ts`、`src/lib/documents/session-client.test.ts`；修改两个 documents route、`http.ts`、`http.test.ts`、`service.ts`、`client.ts`。

**Consumes:** S1/S2 类型与仓储。**Produces:** 会话 API、资源守卫和以下客户端接口，供主计划任务 3—4 使用：

```ts
export class DocumentSessionError extends Error {
  constructor(message: string, readonly status: number, readonly code: DocumentSessionCode,
    readonly session?: AnonymousSessionView) { super(message); this.name = "DocumentSessionError" }
}
export function setDocumentContext(contextId: string): void
export function getDocumentSession(signal?: AbortSignal): Promise<AnonymousSessionView>
export function restartDocumentSession(signal?: AbortSignal): Promise<AnonymousSessionView>
// listDocuments(signal?) / openDocument(id, signal?) 保持原成功结果形状。
// createDocument 在原六参数后接 options: { signal?, retentionConsent? }。
```

`setDocumentContext` 只更新该浏览器页面客户端模块的上下文；不是授权，也不存入 URL/localStorage。
get/restart 不自行覆盖客户端当前上下文，只有工作台确认同代响应或重开成功后调用 setter，防止迟到 GET 恢复旧上下文。

Route Handlers 保持薄。新增 `handlers.ts` 中 `createDocumentCollectionHandlers`、`createDocumentVersionHandlers`、
`createDocumentSessionHandlers` 三个领域专用 factory，接收 `getServices: () => Promise<DocumentServices>`，
分别返回 collection 的 GET/POST、version 的 GET/PUT、session 的 GET/POST；实际 routes 调用同一 factory，测试也调用它。
version 的 GET/PUT 第二参数保持 `{ params: Promise<{ id: string }> }`。
`DocumentServices = { documents: DocumentRepository; sessions: DocumentSessionRepository }`，由 service.ts 的 `documentServices(): Promise<DocumentServices>` 提供。
factory 无模块导入副作用，不包含凭据；不创建通用路由平台。

- [ ] **S3.1 写真实 handlers 的到期/重开测试。**使用 S2 相同的临时 SQLite、固定时钟及策略搭建 services，
不是用假成功响应替代服务端。首个 GET 取得 cookie/contextId，POST 文档带 consent 与上下文；
将注入时钟推进到期限后断言 GET 文档、PUT、copy 和 collection 均拒绝，不能带 blob。
再 POST restart 断言 Set-Cookie 不同、新 owner 列表为空；旧 ID 由归属检查返回 404，旧 cookie 与原 contextId 组合返回 410 且不含 blob。每次写请求都带 Origin。

`session-http.test.ts` 中可直接采用以下完整的合成 HTTP 场景：

```ts
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NextRequest } from "next/server"
import { connectDatabase } from "../database/connection"
import { DocumentRepository } from "./repository"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"
import { blankDocx } from "../../lib/documents/docx"
import { createDocumentCollectionHandlers, createDocumentVersionHandlers, createDocumentSessionHandlers } from "./handlers"

test("DB-08: expired resources stay denied when a new empty session starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-session-http-"))
  const database = await connectDatabase({ provider: "sqlite", path: join(directory, "store.sqlite") })
  let now = new Date("2026-10-22T00:00:00Z")
  const sessions = new DocumentSessionRepository(database, {
    now: () => now, readPolicy: () => retentionPolicy({ ANONYMOUS_DATA_RETENTION_DAYS: "2" }),
  })
  const documents = new DocumentRepository(database, sessions)
  const services = async () => ({ documents, sessions })
  const sessionHandlers = createDocumentSessionHandlers(services)
  const collection = createDocumentCollectionHandlers(services)
  const versions = createDocumentVersionHandlers(services)
  const origin = "https://equilens.invalid"
  let cookie = ""
  let contextId = ""
  const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`${origin}${path}`, {
    method, headers: { Origin: origin, Cookie: cookie, "X-Document-Context": contextId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  try {
    const initial = await sessionHandlers.GET(request("/api/document-session"))
    const view = await initial.json()
    cookie = initial.headers.get("set-cookie")!.split(";")[0]
    const originalCookie = cookie
    contextId = view.contextId
    const created = await collection.POST(request("/api/documents", "POST", {
      title: "合成资料", source: "authored", prompt: "",
      blob: Buffer.from(await blankDocx().arrayBuffer()).toString("base64"), retentionConsent: view.confirmation,
    }))
    assert.equal(created.status, 201)
    const saved = await created.json()
    const active = await (await sessionHandlers.GET(request("/api/document-session"))).json()
    now = new Date(active.expiresAt)
    const expired = await collection.GET(request("/api/documents"))
    assert.equal(expired.status, 410)
    const failure = await expired.json()
    assert.equal(failure.code, "RETENTION_EXPIRED")
    assert.equal("blob" in failure, false)
    const originalContextId = contextId
    const restarted = await sessionHandlers.POST(request("/api/document-session", "POST", { action: "restart", expectedContextId: contextId }))
    assert.equal(restarted.status, 200)
    cookie = restarted.headers.get("set-cookie")!.split(";")[0]
    assert.notEqual(cookie, originalCookie)
    contextId = (await restarted.json()).contextId
    assert.deepEqual(await (await collection.GET(request("/api/documents"))).json(), [])
    const oldFile = await versions.GET(request(`/api/documents/${saved.document.id}`), { params: Promise.resolve({ id: saved.document.id }) })
    assert.equal(oldFile.status, 404)
    cookie = originalCookie
    contextId = originalContextId
    const stale = await collection.GET(request("/api/documents"))
    assert.equal(stale.status, 410)
    const staleFailure = await stale.json()
    assert.equal("blob" in staleFailure, false)
  } finally { await database.close(); await rm(directory, { recursive: true }) }
})
```

这些 response 必须由本任务 handlers 与实际临时仓储产生。测试结束关闭数据库、删除本任务临时目录。

- [ ] **S3.2 实现身份、header 和 safe errors。**`session(request, options?: { rotate?: boolean })` 保留 256 位随机 token、HttpOnly、SameSite=Lax，并按数据库规格仅在 HTTPS 下设置 Secure；
rotate 强制生成新 token，只在成功响应写 cookie。每个资源请求在解析私有内容之前检查 `X-Document-Context`，
与当前 cookie 对应的 contextId 不同返回 SESSION_CHANGED；上下文缺失返回 SESSION_CONTEXT_REQUIRED。
`StoreError` 增加可选 code 和安全 session view，failureResponse 返回固定安全字段；未知异常仍 503 且无底层错误。
- [ ] **S3.3 实现 get/restart 和文档守卫。**GET 会话不返回 owner/raw token；POST 只接受 action=restart 及 expectedContextId，
同源且旧状态 expired 才签发新身份，其他状态返回 409 `SESSION_RESTART_NOT_ALLOWED`（该码已在 S1 共享 union 中，直接复用，不重复定义）。
文档 POST 把结构校验后的 consent 传入仓储，不相信客户端 canCreate/expiresAt；PUT/open 继续仓储内检查。
校验/序列化前后核对访问状态，长请求跨过期限时不能在确认失效后继续提交或返回文档字节。
- [ ] **S3.4 实现客户端错误分类和取消。**所有 fetch 使用同源凭据与 no-store。文档请求携带 setDocumentContext 登记的 header；
对成功响应先核对上下文再解码字节。只有 REVISION_CONFLICT 或明确兼容的旧保存冲突才转 RevisionConflict，
其余会话码转 DocumentSessionError；不要将期限确认变化误导成“另存为新文档”。编码前后、请求前和解码后检查 signal。
- [ ] **S3.5 写错误区分测试。**客户端本身无浏览器初始化副作用，用 Node 测试 mock fetch，隔离每个测试的上下文：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentSessionError, openDocument, setDocumentContext } from "./client"

test("DB-08: a session conflict is not a document revision conflict", async t => {
  setDocumentContext("synthetic-context")
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: "会话已变更，请重新读取文档。", code: "SESSION_CHANGED",
  }, { status: 409 }))
  await assert.rejects(openDocument("synthetic-document"), failure =>
    failure instanceof DocumentSessionError && failure.code === "SESSION_CHANGED")
})
```

另测 410、真正 REVISION_CONFLICT、已 abort 的请求不发 fetch、不同 context 的成功响应不交给 decode。
- [ ] **S3.6 回归 Origin 与隐私头。**真实 handlers 测试缺 Origin、错误 Origin、其他 cookie/复制来源、损坏/超限文件、
错误码中无 SQL/password/owner/raw cookie；同一请求在慢校验结束前到期时无新文档。保持原 http/repository 测试断言不削弱。
- [ ] **S3.7 验证并保存任务边界。**运行 `pnpm exec tsx --test src/server/documents/http.test.ts src/server/documents/session-http.test.ts src/lib/documents/session-client.test.ts` 及 `pnpm check`；建议提交 `feat: expose guarded document session controls`。本任务后允许主计划任务 4 联调，不声明物理清理已完成。

## S4：持久删除意图、启动重放与周期清理

**Files:** 新建 `src/server/documents/retention-cleanup.ts`、`retention-cleanup.test.ts`、`src/instrumentation.ts`；修改 `service.ts` 和数据库规格的运行细节。

**Consumes:** S2 的期限表、Database/Connection 和过期 owner 查询；**Produces:**

```ts
export type DeletionIntent = {
  id: string
  owner: string
  expiresAt: string
  requestedAt: string
  reason: "anonymous-expired"
}
export interface DeletionJournal {
  appendIntent(intent: DeletionIntent): Promise<void>
  readIntents(): Promise<DeletionIntent[]>
}
export function createFileDeletionJournal(directory: string): DeletionJournal
export function replayDeletionIntents(database: Database, journal: DeletionJournal): Promise<void>
export function cleanExpiredSessions(database: Database, sessions: DocumentSessionRepository,
  journal: DeletionJournal, now: () => Date): Promise<{ deleted: number; failed: number }>
export function createRetentionRuntime(options: {
  initialize: () => Promise<void>
  sweep: () => Promise<void>
  schedule: (tick: () => void, intervalMs: number) => (() => void)
}): { start(): void; stop(): Promise<void>; ready(): Promise<void> }
export function startRetentionRuntime(): void
export function stopRetentionRuntime(): Promise<void>
export function retentionRuntimeReady(): Promise<void>
```

服务端的 `documentServices()` 等待 `retentionRuntimeReady()`，但配置对象/健康路由和 module import 不等待或发起该操作。
实现时将数据仓储初始化和对外 ready 门分开：service.ts 的 `initializeDocumentServices(): Promise<DocumentServices>`
只建立仓储；runtime 在显式 start 中动态取得它，初始化/重放后放开 ready。
`documentServices()` 只等待 runtimeReady 再返回相同仓储，避免 runtime→documentServices→runtimeReady 的循环依赖。
`createRetentionRuntime` 是可测试的领域生命周期实例；全局 start/stop/ready 包装器只持有一个生产实例，不在模块顶层调用。

- [ ] **S4.1 写清理与重放行为测试。**创建两个独立 owner：到期 owner 有原件、历史版本及 copy，另一个有效 owner 有独立文档；
保留到期前的 SQLite 一致性备份。用固定 now 触发清理后，断言到期 owner 的 documents/revisions（含会话输入/prompt 元数据）与临时派生数据被清除且留下删除记录，
有效 owner 的摘要不变；再把备份恢复到新的临时数据库，先重放较新的删除日志，断言旧原件仍不可读取。
注入 journal 写失败时，断言未执行物理 DELETE，但期限守卫仍拒绝访问；注入 DB 删除失败后，用同一日志重试，不追加重复意图。
- [ ] **S4.2 实现单独于 SQLite 快照的私有日志。**配置 `ANONYMOUS_DELETION_JOURNAL_DIR`；SQLite 未指定时使用数据库目录下的
`retention-journal`，GaussDB 模式必须显式指定持久目录。每条意图独立 JSON 文件，只包含上面的安全字段；文件 600、目录 700。
先持久化并确认日志，再执行数据库删除；不能先删行再补记录，不把日志放进 public、镜像或原文日志。

文件写入的关键顺序：

```ts
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"

async function persistIntent(directory: string, intent: DeletionIntent) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await open(join(directory, `${intent.id}.json`), "wx", 0o600)
  try { await file.writeFile(JSON.stringify(intent)); await file.sync() }
  finally { await file.close() }
  const parent = await open(directory, "r")
  try { await parent.sync() } finally { await parent.close() }
}
```

相同 owner/期限先检查既有合法意图，重试复用 ID；任何损坏或无法持久化的日志都不能被当作空日志跳过。
复用既有意图也须确认目录持久化屏障已成功，不能因为文件存在就绕过上次失败的同步步骤。
生产目录同步与重启测试在 Linux 容器执行；Windows 合成测试不替代该持久性证据。

- [ ] **S4.3 实现删除事务与重放。**确认 now 已超过 expiresAt 和适用导出窗口；每轮最多处理 100 个 owner，逐 owner 短事务。
顺序为更新/插入 deletion 记录、将 session.revoked_at 固定、删除该匿名 owner 的 revisions，
再删 documents（含会话输入/prompt 元数据）并清除该 owner 的临时派生数据，最后标 completed_at。
会话输入若在后续步骤单独持久化，必须并入同一删除事务，不得只删 documents/revisions；
同一轮次删除超过运维登记窗口且仍无文档的空会话行（仅行清理，不涉资料）。
保留期限及最小删除元数据以便恢复拒绝；不触碰其他 owner 或未来项目数据。重放按相同顺序幂等执行，异常回滚，不能产生复活窗口。
- [ ] **S4.4 明确日志生命周期。**数据库备份和最新删除日志分别复制到服务器外的私有存储，并记录清单/摘要。
恢复数据库之前取得截至恢复时刻的最新日志，不能只使用旧备份内的旧日志。日志无法读取或重放失败时文档服务拒绝访问，
健康路由不代替数据就绪。日志仅保留到其可能影响的备份全部按产品 §10.5 到期；过期备份不纳入允许恢复集，不永久保留 owner 元数据。
- [ ] **S4.5 接入显式生命周期。**按 [Next.js instrumentation 文档](https://nextjs.org/docs/app/guides/instrumentation) 在 `src/instrumentation.ts` 的 register 内动态导入运行函数；
仅 Node.js runtime 且不是生产构建 phase 时调用。`startRetentionRuntime` 缓存在 globalThis 的本进程状态保证只启动一次：
先重放，再首轮清理，之后每小时检查；每轮不重叠，timer 使用 unref，保留 stop 清理入口。模块导入不得执行这些动作。
启动初始化/重放失败时保存拒绝就绪状态和安全错误，后续显式重试成功前不提供资料；应用健康检查仍可响应。
就绪失败以安全错误 reject 而不是永久 pending：`documentServices()` 收到该拒绝后文档请求返回 503/明确失败，
不挂起连接；显式重试成功后同一 ready 恢复可用，不重建仓储。
ready 以初始化/删除重放成功为准；后续单轮物理清理失败不撤销其他未到期会话的合法访问，但到期守卫一直生效。
- [ ] **S4.5a 先验证生产实例不会重复注册。**在 cleanup 测试文件使用可控初始化与调度器，不导入或启动真实服务：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { createRetentionRuntime } from "./retention-cleanup"

test("DB-08: cleanup lifecycle initializes and schedules only once", async () => {
  let release!: () => void
  const boot = new Promise<void>(resolve => { release = resolve })
  let finishSweep!: () => void
  const swept = new Promise<void>(resolve => { finishSweep = resolve })
  let initializations = 0
  let registrations = 0
  let stops = 0
  const runtime = createRetentionRuntime({
    initialize: async () => { initializations++; await boot },
    sweep: async () => { finishSweep() },
    schedule: () => { registrations++; return () => { stops++ } },
  })
  runtime.start()
  runtime.start()
  release()
  await runtime.ready()
  await swept
  assert.equal(initializations, 1)
  assert.equal(registrations, 1)
  await runtime.stop()
  assert.equal(stops, 1)
})
```

- [ ] **S4.6 写生命周期与构建反例。**验证两次 start 不产生双 timer；模块 import 不连接 DB；失败轮次下一小时可重试但不能放开期限访问；
停止解除 timer、等待当前短事务。用唯一临时 SQLITE_PATH 构建，确认生产 build 没有新建该文件或日志目录；
以当前固定 Next.js 版本实际验证 phase 判定，不能仅凭 NEXT_RUNTIME 推测 build 不会执行。
- [ ] **S4.7 验证并保存任务边界。**运行 `pnpm exec tsx --test src/server/documents/retention-cleanup.test.ts`、`pnpm check` 和隔离构建检查，
在 Linux 容器完成日志持久化/重启/重放测试，建议提交 `feat: clean expired anonymous document sessions`。物理清理超出 24 小时或服务离线时据实记录，不宣称目标必然达成。

## S5：存量登记、通知窗口与恢复工具

**Files:** 新建 `scripts/anonymous-retention.mts`、`scripts/build-retention-tools.mjs`；修改 `package.json`、`docs/deployment.md`；复用 S2/S4 仓储与日志，增加 `src/server/documents/retention-maintenance.test.ts`。

**Consumes:** `LegacyRetentionRegistration`、`registerLegacy`、`replayDeletionIntents`。CLI 只通过受控运维环境访问数据库，不提供公开管理 API。

- [ ] **S5.1 实现清单命令。**`inspect --output` 写私有 JSON 文件，内容仅 owner 哈希、真实最早文档创建时刻、文档/版本数量及登记状态；
不输出正文、文件字节、cookie 或文档标题。按服务端 metadata 的时间解析归并，不能用字典顺序或当前日期代替最早时刻。
清单操作不修改资料/期限；schema 迁移属于 S2，不能由 inspect 顺便登记存量或清理。文件使用独占创建，拒绝覆盖旧清单。
- [ ] **S5.2 实现登记校验。**`enroll --manifest` 接受完整 `LegacyRetentionRegistration[]`，默认只验证并给出合成统计；
只有显式 `--apply` 才登记。验证 owner 已存在、天数合法、operator/purpose/notifiedAt 齐全、结束日期在未来、已提供通知。
最早创建时刻从数据库取，不接受 manifest 伪造。未知 owner 拒绝，不将其创建为可访问会话。
同一登记重放幂等；不相同的已登记记录冲突，不用最新 env 擅自续期。
- [ ] **S5.3 实现 restore replay 命令。**`replay --journal` 先检查日志格式、清单/摘要及目标数据库，默认只报告将处理的 owner 数量；
`--apply` 在应用停止、目标为新恢复库时重放，成功后才能启动文档服务。缺日志、损坏记录或 DB 失败不得打印恢复成功。
工具与 Node 应用共用仓储/重放函数，不写一套不含期限守卫的删除 SQL。
- [ ] **S5.4 提供精确操作入口。**以下路径都属于执行时生成的私有运维文件；不提交这些 JSON，负责人在 inspect 结果中补齐通知和政策登记后另存 enrollment 文件：

```powershell
pnpm exec tsx scripts/anonymous-retention.mts inspect --output data/anonymous-retention-inventory.json
pnpm exec tsx scripts/anonymous-retention.mts enroll --manifest data/anonymous-retention-enrollment.json
pnpm exec tsx scripts/anonymous-retention.mts enroll --manifest data/anonymous-retention-enrollment.json --apply
```

执行真实 `--apply` 不属于本次撰写计划的授权；验证阶段允许在专用合成数据库上使用合成通知与日期执行 `--apply`
以生成迁移窗口状态，合成登记不得进入生产清单。不得填入假通知日期或在计划中指定生产天数。

- [ ] **S5.5 写迁移与原字节回归。**建立 v1 合成数据并记录原件/历史摘要，升级 S2 后断言 legacy_pending 不被自动删除；
登记一份已按创建时刻过期但导出窗口尚未结束的 manifest，断言原 cookie 可下载同一摘要，save/create/copy 被拒绝。
时钟到达窗口末端时读取拒绝，S4 才能清理；另一个独立 owner 的副本保持不变。manifest 缺通知、未知 owner、日期已过、重复冲突必须失败且无资料删除。
- [ ] **S5.6 将 CLI 打入当前容器。**使用已有 esbuild 在 `scripts/build-retention-tools.mjs` 生成
`scripts/generated/anonymous-retention.mjs`，target node24、platform node；将 gaussdb-node 标为 external，验证 Next standalone trace 已带该适配器。
将构建工具加入现有 dev/test/build 链，保留原 docx-validator 构建。`prepare-standalone.mjs` 已复制 generated 目录，实测新 CLI 随镜像存在，
不能假定容器带 tsx。CLI 引用的是无导入副作用的 Node 领域模块，不直接导入 `server-only` 服务入口。
- [ ] **S5.7 验证并保存任务边界。**运行维护、policy、cleanup 测试以及 `pnpm build`；在合成数据库对照 dry-run/apply 的行数和摘要，
建议提交 `feat: add retention enrollment and restore tools`。更新 docs/deployment 的备份、通知、停机恢复和失败处理，保留未验证项。

## S6：配置、容器与第一步联合验收

**Files:** 修改 `.env.example`、`compose.yaml`、`zeabur-template.yaml`、`scripts/smoke-database.mjs`、`.github/workflows/ci.yml`、README、DEVELOPMENT、docs/deployment；执行时写主计划约定的验证记录。

**Consumes:** S1—S5 及主计划任务 4；**Produces:** 生效配置、可复现验证和 DB-08 结果，不包括发布或真实清理操作。

- [ ] **S6.1 更新配置示例而不设置业务默认天数。**`.env.example` 新增以下实际已读取配置，说明用途/期限/迁移登记由负责人决定：

```dotenv
# Required for anonymous document creation; register the purpose and choose the number of days.
ANONYMOUS_DATA_RETENTION_DAYS=
# SQLite defaults to retention-journal beside the database; required explicitly for GaussDB.
# ANONYMOUS_DELETION_JOURNAL_DIR=/data/equilens/retention-journal
```

Compose 传递该值的原样空/非空字符串，不写 `${...:-30}` 一类期限默认。Zeabur 模板增加空的保留天数字段及持久日志目录，
不改镜像为未交付版本、不执行模板部署；UID 1000 可写应用子目录，不修改挂载根目录属主。
- [ ] **S6.2 更新数据库 smoke。**在原脚本中先 GET 会话并保存 cookie/contextId，POST 文档携带 confirmation；
所有文档请求带上下文 header。checkpoint 私有 JSON 保留 contextId 以便容器重启核对，但日志不打印 cookie。
跨会话反例分别初始化 A/B 两套有效 cookie/context，B 请求 A 的真实 ID 必须由归属检查拒绝；
缺上下文/无 cookie 的拒绝另测，不能拿 400/409 的协议错误代替 404 的实际资源隔离断言。
保留原持久化、原件/导出摘要、竞争保存、跨会话复制、Origin、无效 DOCX 断言；不把 400/503 误当作隔离通过。
- [ ] **S6.3 更新 CI 运行环境。**两个 docker run 都传入仅用于合成测试的 `ANONYMOUS_DATA_RETENTION_DAYS=2`
和持久日志目录，仍用同一个隔离卷验证重启；build 阶段不注入期限或访问数据库。发布条件、标签和登录步骤不改。
未运行 GitHub CI 时不得把本地验证写成 CI 通过。
- [ ] **S6.4 执行缺配置反例。**构建不带期限仍通过且没有建立 SQLite/日志文件；运行应用缺期限时 `/healthz` 仍 200，
新匿名文档创建返回 503；正确配置后新建可用。环境变量修正不能改变已有会话的固定期限。
- [ ] **S6.5 执行完整回归。**先完成锁定安装，再依次 `pnpm check`、`pnpm test`、`pnpm build`；
按主计划使用合成数据库与 18081 端口启动，执行 `pnpm smoke http://127.0.0.1:18081` 与更新后的 `node scripts/smoke-database.mjs http://127.0.0.1:18081`；
按现有 Docker 流程在隔离卷验证非 root、资源、重启及 generated CLI。主计划 UI-01—UI-06 交互检查在同一交付版本执行。
- [ ] **S6.6 单列 DB-08 的释放条件。**逐项记录：无默认配置、固定期限、创建日期变化确认、所有资源到期拒绝、
会话输入与临时派生数据清理、离线清理、新会话隔离、存量只读窗口、窗口结束回到 expired、日志失败、DB 失败、
恢复重放和独立副本不受影响。
Linux 持久性或 GaussDB 未测需保留缺口，不降低验收条件；未经验证的 provider 不宣称可交付。
- [ ] **S6.7 更新状态并提交文档。**只有实际实现后才更改 README 当前状态和启动要求；
说明 cookie 不是保留策略、何时不可再读写、如何导出、怎样开新会话、如何登记通知/窗口和恢复删除日志。
执行 `git diff --check`，建议提交 `docs: document anonymous retention operation`，仅暂存本任务明确路径；
与主计划任务 5.7 的 README/DEVELOPMENT 修改分属不同提交，不合并暂存。不发布、推送或部署。

## 最终交付记录

- [ ] S1—S6 逐项有执行结果，失败和未执行不改成通过。
- [ ] DB-01—DB-04 与 DB-08 回归，schema v1 原件/历史字节不变。
- [ ] 主计划 UI-05 使用真实会话 API，UI-01—UI-06 和共用检查完成。
- [ ] 生产保留天数/用途、通知与存量窗口由负责人登记；无默认期限、无假通知。
- [ ] 最新删除日志与数据库备份分别可取得，恢复先重放再开放资料，验证不复活已删除内容。

本计划只列将执行的工作；当前没有新增期限变量读取、自动清理、迁移或部署。

**2026-10-22 修订（审查结论）：**修正状态优先级使“已过期且导出窗口已结束”回到 expired（原规则会落回 new/active）；
`guardIn` 增加 download 动词并固定 read/download/copy 语义，`readPolicy` 改为可空以表达配置缺失；
删除范围补入会话输入/prompt 元数据、临时派生数据与空会话行清理，deletion 表补 `reason` 列、会话表映射 `registration`；
明确 ready 失败以 reject 结算、cookie 仅在 HTTPS 下设 Secure、restart 码复用 S1 union，S3.1 测试补旧 cookie 断言，
S5.4 允许在合成库上执行 `--apply` 生成迁移窗口状态，S6.6 释放清单同步。任务与闸门数量不变。
