# EquiLens 第六轮并行实施计划（C7 生命周期与 A5 平台验收）

> 执行说明：本文件是第六轮实施计划，沿用总计划与第三/四/五轮工作包编号；不新增未经审查的产品契约，不是完成记录，不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round5/business` @ `dd1eb16`（第五轮 C4-UI/C6/C5 与集成已合入；`pnpm test` 919/918+1skip/0；浏览器 11/11；工作树干净）。
> 本轮目标：完成 C 线最后一项 **C7 项目保留、对象清理、删除重放与完整恢复**，并完成 A 线最后一项 **A5 数据库/平台验证与发布集成**（本地可执行部分），产出 A/C 两线收口证据与外部缺项清单。

## 1. 范围

| 包 | 所有者 | 内容 |
| --- | --- | --- |
| W0 | Lead | 规格增补（项目删除/保留/恢复、运维入口）、迁移 0013 DDL 冻结、`.env.example`/README 运维边界、任务板、分支 |
| C7 | Agent E（新 agent-c7-lifecycle） | 项目删除记录/对象回收/删除重放/保留期清扫、运行时与私有维护 CLI、恢复清单与脚本、守护测试 |
| A5 | Agent F（新 agent-a5-platform） | SQLite 备份/恢复、卷式重启、完整项目恢复演练（新根目录+对象+日志重放）、5 用户并发/队列容量、迁移账本与 CI/部署事实登记与缺项、门禁与证据 |
| I1 | Lead | 迁移注册、运行时接线、跨包审查、全量门禁、最终 A/C 验收证据与 AC 对照、提交 |
| Review | 独立交叉审查 | C7/A5 实现与证据 |

**不在本轮**：真实 GaussDB/OBS/OCR/MaaS、公网 HTTPS、GitHub CI 运行、Docker/Linux 容器、领域签核与法律质量集；这些保持外部缺项并如实记录。

## 2. 分支与写作用域

集成分支：`alaaladaka/round6/lifecycle`（从 `dd1eb16` 建立）。共享文件只由 Lead 修改。

| 所有者 | 独占写作用域 |
| --- | --- |
| Agent E（C7） | `src/server/projects/{lifecycle,lifecycle-schema,reclamation,deletion-journal,retention,repository,service,handlers,access,authorization}.ts` 及测试；`src/app/api/projects/[id]/route.ts`、`src/app/api/projects/[id]/deletion/route.ts`；`scripts/project-lifecycle.mts`；`src/server/documents/retention-journal.ts` 中抽出的通用文件意图日志（仅限被 C7 复用的最小重构，不改匿名语义） |
| Agent F（A5） | `scripts/backup-objects.mjs`、`scripts/restore-verify.mjs`、`scripts/seed-restore-project.mts`、`scripts/smoke-database.mjs` 的必要增强；`docs/deployment.md`、`docs/operations.md` 的平台验证章节；`docs/reviews/2026-10-29-round-six-a5-platform.md` |
| Lead | `spec/**`、`src/server/database/migrations*`、`src/instrumentation.ts`、`src/server/projects/runtime.ts`（接线）、`package.json`、`.env.example`、`README.md`、`scripts/build-retention-tools.mjs`、最终证据/提交 |

文档所有权：`docs/deployment.md`/`docs/operations.md` 由 A5 单一维护，C7 的运维命令与恢复顺序以文字交接给 A5 合入；README/`.env.example` 由 Lead 统一维护。C7 运行时文件（`projects/runtime.ts`）由 Lead 接线/维护，C7 只提供生命周期实现与启动函数。

## 3. 迁移 0013（W0 冻结 DDL，Lead 注册）

```sql
CREATE TABLE equilens_project_deletions (
  id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, intent_id VARCHAR(36) NOT NULL,
  reason VARCHAR(32) NOT NULL, state VARCHAR(16) NOT NULL, requested_by VARCHAR(36) NOT NULL,
  requested_at VARCHAR(32) NOT NULL, retention_until VARCHAR(10), attempts INTEGER NOT NULL,
  last_error VARCHAR(500), completed_at VARCHAR(32), cleared_at VARCHAR(32), UNIQUE(project_id)
);
CREATE INDEX equilens_project_deletion_state ON equilens_project_deletions(state, requested_at);
CREATE TABLE equilens_project_reclamations (
  id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, object_key VARCHAR(512) NOT NULL,
  state VARCHAR(16) NOT NULL, attempts INTEGER NOT NULL, last_error VARCHAR(500),
  created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, cleared_at VARCHAR(32), UNIQUE(object_key)
);
CREATE INDEX equilens_project_reclamation_state ON equilens_project_reclamations(project_id, state);
```

- 0013 是当时下一连续编号；只 CREATE TABLE/INDEX；不假设 FK/CHECK；状态与转换由服务层校验，条件更新断言恰好影响一行。`requested_by` 可为系统清扫值（如 `system:retention`）；`retention_until` 记录删除时项目保留期限；`completed_at` 表示访问撤销/重放记录完成，`cleared_at` 表示对象与行清理完成。
- 现有 `DELETE /api/projects/[id]`（`app/api/projects/[id]/route.ts` → handlers → service → repository 只改 status）由 C7 接管：**同一数据库事务**写入 `status='deleted'` 与 `equilens_project_deletions` requested 记录（重复删除幂等）；对历史遗留“deleted 但无删除记录”的项目由 CLI/管理入口补记（reconcile），不得绕过。
- 项目行保留 `status='active'|'deleted'`（0004 checksum 冻结，不 ALTER），`deleting/deleted` 由删除记录表达；项目行永不物理删除（墓碑，防旧备份恢复后复活）。
- **每请求保留期撤销**：`findActive`/`findMember`/`listFor`/`authorizeTaskExecution` 在返回前派生检查 `retention_until`；到期项目一律按不存在/无权限拒绝，列表排除；不依赖小时级清扫。合成项目不自动清扫（须显式删除或归档——归档本轮不交付，单列未运行）；授权材料项目到期后由清扫进入删除流程，先撤销访问再清理。
- 覆盖清单 `PROJECT_SCOPED_TABLES`（冻结）：材料原件/版本、上传意图/残留、快照/片段、项目文档/版本/写入意图、成果四表、导出、任务/预算、成员/审计、C4 OCR/字段/外部核验记录、C5 拟约定输入；**B 线运行时建表的 facts/payments/evidence 也列入覆盖**（表存在才删除，缺失跳过并记录 B 线未接线；守护测试通过仓储 initialize 引导这些 schema 后断言覆盖）。全局知识/规则发布版本、认证/账号/匿名 owner 表不随项目删除。守护测试枚举 `sqlite_master` 中含 `project_id` 的表，凡不在清单即失败。

## 4. W0 冻结接口

### 4.1 规格增补（先改规格再实现）
- `spec/01-product.md` §10.4—10.5：项目级完整恢复定义（登录、打开原件字节+摘要、定位来源逐字、读历史成果/复核、下载导出字节、任务/预算历史、已删项目恢复后 404）；删除/保留/重放顺序（先撤销访问→删除日志落盘→对象清理→按序删行→完成）；失败保留可重试记录、绝不回 active；恢复时重放删除记录不复活已删项目；合成项目不自动清扫。
- `spec/04-database-deployment.md`：0013 归属与表；`PROJECT_DELETION_JOURNAL_DIR`、`PROJECT_LIFECYCLE_*` 运维配置；项目生命周期运行时在显式 Node 生命周期启动（先于材料孤儿对象修复）；运维命令 `maintain-project-lifecycle` 与离线重放参数。
- `spec/04`/`docs/deployment.md`：禁止只备份数据库；备份集必须含对象清单/摘要与删除日志、应用/模板版本、非敏感配置名清单与密钥安全恢复说明；恢复步骤与新环境验证清单；恢复后清除过期租约与在途任务、按原输入恢复，不信任旧进程。README 补充运维边界。
- `spec/01-product.md` §10.4：完整恢复后重放删除记录，已删除项目不得复活；恢复旧备份时以删除日志为权威，恢复时应停止写入（quiesced 一致备份）后再重放。
- 保留期（§3）：`authorization`/`access`/`repository` 与后台任务授权在任何请求/领取/阶段读取前派生检查项目 `retention_until`；到期即按不存在/无权限处理，列表排除；清扫只是清理，不是撤销访问的前提。
- 删除状态入口：`GET /api/projects/[id]/deletion` 在项目删除后仍可由**删除请求人 `requested_by` 与超级管理员**读取（只返回删除状态/attempts/时间，不返回任何项目内容）；其他当前项目管理员仅在其成员行尚未清理时可按现有项目成员判定读取，成员行清理后统一 404；其余账号一律 404。冻结规则不新增“删除时管理员名单”列；测试覆盖清理前管理员可读、清理后非请求人 404、请求人/超管在清理后仍可读。

### 4.2 运行时与运维入口（冻结）
- **启动/就绪契约**：`startProjectLifecycleRuntime()` 显式初始化生成清理器、打开/校验删除日志目录、随后先执行一次未完成删除的恢复（replay/reclaim 待办），完成后才置 lifecycle ready；`instrumentation.ts` **只启动 lifecycle 运行时而不阻塞服务器/健康接口**，随后以后台启动链在 `lifecycle.ready()` 完成后再启动 material runtime（孤儿对象修复必须在 lifecycle ready 之后）→ review/verification/knowledge → task runner；顺序冻结为 auth → 匿名 retention → project lifecycle start（不 await 重放）→ 后台链：lifecycle ready → material → review/verification/knowledge → task runner。公共健康接口始终可用且**不得**报告业务/生命周期 ready；**就绪门禁位置**：`src/server/projects/access.ts`/`authorization.ts` 的 `requireProjectAccess`、`authorizeTaskExecution`、项目列表/创建入口在 lifecycle 未 ready 时返回 503“服务暂时不可用”；不在各 materials/results/exports/verification/drafting 适配器重复判断。日志目录不可写/初始化失败时 lifecycle 不 ready 且不服务项目数据；单飞不重叠、timer unref、`stop()` 等待当前短事务结束。测试：慢/失败初始化时健康接口可响应、业务入口 503、material repair 仅在 ready 后启动、重放先于对外可见、清扫中 stop。
- **删除日志冻结契约**（`ProjectDeletionIntent`，一意图一文件）：
  ```ts
  type ProjectDeletionIntent = {
    version: 1; id: string; projectId: string
    reason: "user-delete" | "retention-expired" | "admin-remove"
    requestedBy: string; requestedAt: string   // ISO-8601 UTC
    retentionUntil: string                      // YYYY-MM-DD
  }
  ```
  文件名为 `<intent id>.json`（目录 `PROJECT_DELETION_JOURNAL_DIR`），内容为**单个** `ProjectDeletionIntent` 对象；写入采用临时文件+fsync+原子 rename，并对日志目录及上级目录逐级 fsync（沿用匿名日志 `syncDirectory()` 做法）；严格校验精确字段集、reason 枚举、uuid/时间/日期格式，重复 id（已存在同名文件且内容不同）拒绝。`reason` 常量集与 `equilens_project_deletions.reason` 共用同一冻结集合；日志只保留元数据，不含项目名/材料正文。删除流程顺序：DB 事务（撤销访问 + requested 记录 + intent id）→ 日志 fsync → 对象清单（分页）→ 删除对象（逐条 attempts）→ 按序删行 → 完成。日志不可写时不删除任何对象、停留 requested 每小时重试、访问保持撤销。离线恢复重放（`--offline-restored-database`）：先整批校验（重复 id/坏 JSON/同项目多 intent 的 requestedAt 冲突拒绝），逐项目幂等——恢复库存在项目行则置 `status='deleted'` 并补写/校验删除记录；行不存在只写墓碑记录，**绝不创建/恢复 active 项目**；对象清单从恢复库行重建，缺失对象按已清理记录，遗留对象记录到回收表重试；重放要求备份是在停止写入后取得的一致备份。测试：旧备份（删除前）→重放→项目 404 且项目对象/行清除；删除后备份→重放 no-op；坏日志/重复 id/冲突拒绝。
- **环境变量冻结**：`PROJECT_DELETION_JOURNAL_DIR`（SQLite 默认数据库旁 `project-deletion-journal`；GaussDB 必须显式）、`PROJECT_RECLAIM_BATCH`（默认 10、上限 100）、`PROJECT_LIFECYCLE_INTERVAL_MS`（默认 3600000，最小 60000）、`PROJECT_EXPIRY_CLOCK` 仅测试注入（生产用系统时钟，不读取环境）；合成项目自动归档本轮不交付并单列未运行。
- 运维入口：`scripts/project-lifecycle.mts`（`inspect|reclaim|replay`，显式数据库初始化、脱敏输出、退出码 0/1/2）；加入 `scripts/build-retention-tools.mjs` 与 `package.json` 入口。

### 4.3 A5 验收口径（本机可执行）
- 恢复演练脚本 `scripts/seed-restore-project.mts`（Agent F）建立可复现完整项目：材料上传/解析、C4 证照字段/要求集/比较成果、C5 拟约定输入/草稿、导出、任务/预算、成员；记录版本与摘要。
- 备份集：`scripts/backup-sqlite.mjs` 一致备份 + 复制 `data/dev-objects` 与删除日志 + `scripts/backup-objects.mjs` 生成 `{version,root,objects:[{key,sha256,size}]}` 清单 + 应用/模板版本、非敏感配置名清单与密钥安全恢复说明；备份前停止写入（quiesced）。
- **删除重放双向演练**：(a) 删除前备份 → 新根恢复 → `replay --offline-restored-database` → 项目 404 且对象/行清除（证明旧备份不复活已删项目）；(b) 删除后备份 → 新根恢复 → replay no-op（不得再删其他项目）。
- 恢复验证 `scripts/restore-verify.mjs`（纯 HTTP）：登录、打开原件字节+sha256、定位来源逐字、历史成果/复核、导出下载 sha256、任务/预算历史、已删项目 404；另核 `PRAGMA integrity_check`、对象清单与删除日志应用、新路径与保留期；恢复时清除过期租约/旧执行令牌与在途任务（按原输入恢复，不信任旧进程）。
- 卷式重启：同数据目录重启后对象/摘要/任务/导出仍可用；`smoke-database --verify` 跨重启。
- 容量确定性 harness：分两层——(a) 仓储层边界用可控 runner/注入时钟的确定性测试（claim 暂停、同用户 2 未终结、全局排队 10、重复提交幂等/429），不新增仅测试可用的生产执行器开关；(b) HTTP 层用 CLI 创建 5 个合成账号加入项目，并行执行查看/保存/任务查询并记录耗时、错误与用量。不承诺 SLA。
- 迁移账本：空库/重复启动/摘要冻结/回滚/0001—0012 不变；数据库错误不降级、构建不连库；0013 注册后同验。
- CI/部署事实登记：工作流存在但无运行记录，镜像/HTTPS/容器/GaussDB/异地备份未验证；`.env.example`/README/部署与运维文档补充“只备份数据库不够”、恢复/保留/删除边界、开发对象存储非 OBS 验收。
- 证据记录实测恢复耗时与损失窗口（仅陈述实测，不承诺 4 小时目标）；基线 919 测试/浏览器 11 项在证据中复核。

## 5. 工作包

### C7（Agent E）
- [ ] 接管现有删除路径：`app/api/projects/[id]/route.ts` → handlers → service → repository；状态撤销与删除记录**同一事务**写入；重复删除幂等；对历史 record-less deleted 项目提供 reconcile。
- [ ] 每请求保留期撤销：`authorization`/`access`/`repository`/`authorizeTaskExecution` 派生检查到期；列表排除；注入时钟测试；合成项目排除自动清扫。
- [ ] 删除记录/回收记录仓储与状态机（requested→reclaiming→reclaimed/failed；条件更新一行；幂等并发；删除意图唯一）。
- [ ] 删除日志冻结契约实现/校验/批预校验/fsync；离线恢复重放幂等与“绝不复活/绝不新建 active”；坏日志/冲突拒绝。
- [ ] 对象清单与回收（按项目分页覆盖全部项目私有对象键；逐条 attempts；不误删已引用/其他项目对象；存储未配置 fail-closed）；在途上传→孤儿对象竞态按 fence/重试处理并记录残留。
- [ ] 按序删行（覆盖 §3 `PROJECT_SCOPED_TABLES`，含 C4/C5 与运行时 B 线表存在才删；先子表后引用表；不依赖 FK 级联）；守护测试 bootstrap 运行时 schema 后枚举 `sqlite_master` 断言覆盖，白名单仅墓碑/全局/认证/匿名表。
- [ ] 保留期清扫（仅授权材料项目；到期先撤销访问再进入删除；配置边界与 env 冻结）。
- [ ] 运行时 `startProjectLifecycleRuntime()`（initialize/ready/replay 先于对外可见、单飞、可停止、unref；失败不 ready 且不泄露 restored active 项目）与 CLI `inspect|reclaim|replay`（离线参数、脱敏、退出码、build-retention-tools/package 入口）。
- [ ] `GET /api/projects/[id]/deletion`（删除后：请求人 `requested_by`/超管始终可读；其他当前项目管理员仅成员行尚未清理时可读；其余统一 404；只返回状态/attempts/时间；no-store）。
- [ ] 测试：状态机/幂等并发/对象+行全覆盖/C4+C5 delete-seeded/跨项目与匿名隔离/注入删除失败重试/日志 fsync 失败/旧备份重放不复活+删除后备份 no-op/reconcile/保留期边界/就绪门禁/存储未配置 fail-closed。
- 证据 `docs/reviews/2026-10-29-round-six-c7-lifecycle.md`；不宣称真实 OBS/异地备份/GaussDB/Linux 容器。

### A5（Agent F）
- [ ] `scripts/seed-restore-project.mts` 可复现完整项目夹具（含 C4/C5 成果与导出）；备份集含对象清单/删除日志/应用与模板版本/配置名清单/密钥恢复说明；备份前 quiesced。
- [ ] 双向删除重放演练（删除前备份恢复→重放→不复活；删除后备份→重放 no-op）与恢复验证脚本 `scripts/restore-verify.mjs`（HTTP 逐项+integrity_check+清单/日志应用+租约/令牌清理）。
- [ ] 卷式重启与 `smoke-database --verify` 跨重启；迁移账本验证（含 0013）。
- [ ] 容量确定性 harness：仓储层边界测试（可控 runner/注入时钟；每用户 2、队列 10、幂等/429）+ HTTP 5 合成账号并发（耗时/错误/用量）；不承诺 SLA。
- [ ] CI/部署/HTTPS/容器/GaussDB/异地备份事实与缺项登记；docs/deployment、docs/operations、README 边界更新；基线 919/浏览器 11 项复核。
- [ ] 汇总工程门禁与实际证据；证据 `docs/reviews/2026-10-29-round-six-a5-platform.md`。
- [ ] 依赖：恢复演练在 C7 合入后执行（Lead 通知）；备份工具/容量/迁移验证可先行。

### I1（Lead）
- [ ] 迁移 0013 注册与 checksum；instrumentation 接线 C7 运行时；package.json 测试路径与运维脚本入口；build-retention-tools 打包。
- [ ] 合入顺序：C7 → A5；每包定向检查后按路径提交；独立交叉审查（task-17）与复审。
- [ ] 门禁：`pnpm check/test/build/smoke`、`git diff --check` 全部 exit 0；测试数如实记录。
- [ ] 最终 A/C 收口：`docs/reviews/2026-10-29-ac-final-acceptance.md`（A1—A5、C1—C7 状态表、AC 对照、外部缺项、未宣称项），任务板与 README 状态更新。
- [ ] 不推送、不部署、不建 Issue。

## 6. 合入顺序、门禁与证据
1. W0：分支、规格、DDL、运维边界；`pnpm check` 基线。
2. C7 先行（对象回收/日志/删除/重放/测试）；完成后 Lead 注册 0013 并接线运行时、提交，再通知 A5 执行恢复演练。
3. A5 并行完成备份工具/容量/迁移/文档，C7 合入后执行完整恢复演练与卷式重启。
4. 交叉审查 BLOCKER 修复后复核；门禁全绿；证据提交。
5. 不把本机 Windows/SQLite/合成存储结果表述为真实云服务、Linux 容器或 GaussDB 验收。

## 7. 不宣称与外部缺项
- 真实 GaussDB/DB-07、真实 OBS 私有桶/版本保护、MaaS/OCR、公网 HTTPS、GitHub CI 运行、Docker/Linux 非 root/fsync/卷恢复、ECS 外异地备份/24 小时备份窗口：未验证，保持缺项。
- AC-12/16/25/26 仅按本地实际恢复演练与容量证据说明支持范围，不宣称整项通过或线上 SLA/4 小时恢复目标；实测耗时与损失窗口只作本机记录。
- 领域签核、法律/资格质量、24/60 例业务集、真实 Word 排版：未运行，不宣称。
- 合成项目自动归档（synthetic archive）本轮不交付，单列未运行；在途上传→孤儿对象竞态保留残余记录，不宣称零残留；删除状态 UI、C6 规范库 UI、C5 正文编辑与催款函仍不在本轮。
- 合成数据与夹具不得作为真实服务、真实项目或法律结论证据；A5 容量为合成身份实测，不是生产容量承诺。
- 证据中复核基线（第五轮 919 tests/918 pass/1 skip、浏览器 11 项），不得把基线结果当作本轮新执行结果。

## 8. 收口与停止条件
- C7 与 A5 本轮验收通过（本地可执行部分 + 外部缺项如实登记）后：A1—A5、C1—C7 全部工作包完成；第七轮仅用于最终复核/证据修补（如需要），无新实现。
- 完成条件：门禁全绿（check/test/build/smoke/diff-check）、C7/A5 证据齐备、最终 A/C 收口文档与 AC 对照完成、外部缺项清单明确、工作树干净且提交完成。
