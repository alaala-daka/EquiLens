# 第六轮 A5 平台验证与恢复演练证据（2026-10-29）

> 工作包：R6-A5（Agent F）。分支 `alaaladaka/round6/lifecycle`；基线 `ed7b585`，C7 合入后 HEAD `896cec3`（C7 包 `4ac0d61` + 0013/接线 `896cec3`）。
> 本文件只记录**实际执行**的命令、退出码与测量值；未运行项单列。未执行 `git add` / `git commit` / 推送 / 部署（A5 文件保持未提交，由 Lead 提交）。
> 环境：Windows 本机、Node 24、SQLite（`node:sqlite`）、**开发文件对象存储**（`EQUILENS_SYNTHETIC_STORAGE=1`）、合成数据、本地 `http://127.0.0.1:3000`。
> 这**不是** OBS/GaussDB/Linux 容器/CI/公网 HTTPS/异地备份验收。临时演练根目录：`C:\Users\aefar\AppData\Local\Temp\equilens-r6-a5\`（仓库 `data/` 未用于演练）；服务日志/PID 与浏览器截图在 `.superpowers/round6/`；全部服务已停止、端口 3000 已释放。

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `scripts/seed-restore-project.mts` | 可复现完整合成项目 seed（C4/C5 成果与导出、任务/预算、成员、删除演练项目、私有 checkpoint）；子命令 `migrations`、`capacity-repository`、`capacity-http` |
| `scripts/backup-objects.mjs` | 完整备份集：quiesced 写锁守卫 + SQLite 一致快照（VACUUM INTO）+ 逐对象摘要校验/复制 + 删除日志 + `manifest.json`（对象清单/数据库摘要/应用与模板版本/配置名清单/密钥恢复说明/迁移账本） |
| `scripts/restore-verify.mjs` | 新根恢复（数据库/对象/日志逐字节校验）+ 清除过期租约/旧执行令牌/在途任务 + C7 `replay --apply --offline-restored-database` + 墓碑/行/对象清理核对 + 纯 HTTP 验收 |
| `scripts/smoke-database.mjs`（增强） | 离线 `--verify-migrations <reference.json>`（编号/冻结摘要/数量/0013 + integrity/外键）与 `--integrity`；`--verify` 卷式重启时附带数据库 integrity 校验 |
| `docs/deployment.md`、`docs/operations.md` | “只备份数据库不够”、完整备份集/恢复/重放/保留/删除边界、开发对象存储非 OBS、容量与外部缺项 |

## 2. 实际执行的命令与结果

### 2.1 离线工具（在 C7 合入前的 `ed7b585` 上执行，脚本与结果仍有效）

| # | 命令 | 退出码 | 结果（实测） |
| --- | --- | --- | --- |
| 1 | `seed --root <temp>/seed` | 0 | 完整项目 seed 成功；`elapsedMs=1385`；2 材料 + 4 对象；C4 要求集 `valid`、比较成果 `valid`+复核 `approved`、C5 草稿 `partial`、导出 2525 B；任务 `bid-verification success` |
| 2 | `migrations --out <temp>/migration-reference.json`（当时 12 迁移） | 0 | 空库应用/重复启动/冻结 0001+0004—0012/漂移与截断拒绝/失败回滚全部通过 |
| 3 | `capacity-repository` | 0 | 生产限额 2/10；每账号第 3 个 429 不落库、队列第 11 个 429、幂等、409、单飞租约、过期租约恢复；`totalElapsedMs=11` |
| 4 | `backup-objects.mjs`（seed 根） | 0 | 一致快照数据库 552,960 B、4 对象逐字节校验、`elapsedMs=29` |
| 5-6 | `smoke-database --verify-migrations` / `--integrity` | 0 / 0 | 账本、integrity、外键通过 |
| 7 | `restore-verify.mjs`（backup-before → 新根，无 replay） | 0 | 对象清单精确覆盖；恢复复制 10 ms（总 26 ms）；租约清理；保留项目完整 |
| 8 | 备份时另开写事务 / 篡改备份对象 / 篡改迁移账本 / 日志与 manifest 不一致 / 重复 seed 既有根 | 2 / 1 / 1 / 1 / 1（均预期失败） | quiesce 守卫 `database is locked`（不建输出目录）、对象摘要不一致、`迁移 0010 摘要与参考不一致`、日志清单不一致、`拒绝覆盖` |
| 9 | `restore-verify --inject-stale-attempt` | 0 | 注入 `running` 旧令牌/租约任务后清理为 `queued recovered`，旧令牌 0 |
| 10 | `.mts` replay CLI 占位脚本启动机制 | 0 | tsx 装载、环境传递、退出码正确（209.96 ms） |

### 2.2 合入 C7 后的完整双向删除重放演练（本机真实 HTTP/CLI）

前置：`pnpm exec tsx scripts/seed-restore-project.mts seed --root <drill>/seed`（exit 0，`elapsedMs=1380`，4 对象）；`migrations --out <drill>/migration-reference-final.json`（exit 0，**13 迁移且含 0013**，冻结 0001+0004—0012 不变、0013 为追加且已有账本参考）。

| # | 步骤 | 退出码 | 结果（实测） |
| --- | --- | --- | --- |
| D1 | 停止服务后 `backup-objects.mjs`（删除前） | 0 | 数据库 626,688 B；**对象 4**；删除日志 0；迁移 13；`elapsedMs=32` |
| D2 | 启动 dev server → 管理员登录 → `DELETE /api/projects/<B>`（canonical HTTP） | 0 | HTTP **204**；`deleteMs=592.76`（含服务端日志 fsync/回收启动） |
| D3 | `GET /api/projects/<B>/deletion` | 200 | 立即 `state=reclaimed`、`attempts=1`、`completedAt`/`clearedAt` 已设置；响应仅状态/时间/尝试次数，无项目内容；`Cache-Control: private, no-store` |
| D4 | 项目列表 / 项目内容读取 | 200 / 403 | B 已从列表消失；项目与材料读取对非成员统一 403（C1 非成员统一拒绝语义；不是 404） |
| D5 | `project-lifecycle inspect` | 0 | `state=reclaimed`、`attempts=1`、`pendingObjects=0`、`clearedObjects=1`、`pendingReclaimProjects=0`、`recordlessDeleted=0` |
| D6 | 停止服务后 `backup-objects.mjs`（删除后） | 0 | **对象 3**；**删除日志 1**（B 意图文件）；迁移 13；`elapsedMs=32` |
| D7 | 删除后库静态核对（独立脚本） | 0 | 项目行 `status=deleted` 墓碑；删除记录 `reclaimed`；**24 张含 project_id 的项目私有表均为 0 行**；成员 0；B 对象 0；日志意图 projectId=B |
| D8 | **演练 a**：`restore-verify --set backup-before --replay-cli scripts/project-lifecycle.mts --require-deleted` | 0 | 恢复复制 10 ms；replay **221.41 ms**；总 255 ms。replay 输出 `revoked=1, reclaimed=1, pending=0, tombstones=0`，跳过 4 张未接线的 B 线运行时表；B 墓碑 `reclaimed`、24 张表 0 行、B 对象清除、A 完整（3 结果版本/1 导出/1 任务）；**旧备份未使 B 复活** |
| D9 | **演练 a HTTP**：`restore-verify --use-restored --base ... --require-deleted` | 0 | 22 项检查全 PASS；登录/原件 sha256/来源逐字/要求集+比较成果+复核批准/草稿/导出下载 sha256+size（2527 B）/任务预算历史/A 列表/B 403+列表不可见/删除状态 200；19 次 HTTP，总 7.53 s（p50 555 ms，含首次编译） |
| D10 | **演练 b**：`restore-verify --set backup-after --replay-cli ... --require-deleted --expect-noop` | 0 | 恢复复制 9 ms；replay **204.05 ms**；总 233 ms。`revoked=0,tombstones=0,reclaimed=0,pending=0` → **删除后备份重放 no-op**；A 完整、B 仍清除 |
| D11 | **演练 b HTTP**：`restore-verify --use-restored --base ... --expect-noop --require-deleted` | 0 | 22 项检查全 PASS（同 D9，B 仍不可见、A 完整）；总 7.27 s（p50 570 ms，含首次编译） |

### 2.3 卷式重启 / 迁移 / 容量 / 浏览器基线

| # | 命令 | 退出码 | 结果（实测） |
| --- | --- | --- | --- |
| V1 | 全新卷式根启动 → `smoke-database.mjs <origin> <checkpoint>` | 0 | 匿名会话、保留确认、保存/竞争/所有权/Origin/无效文件检查通过；写私有 checkpoint |
| V2 | 停止后同数据目录重启 → `smoke-database.mjs <origin> <checkpoint> --verify --database <path>` | 0 | 跨重启会话/文档/revision/摘要一致；附加 `Database integrity_check + foreign_key_check passed across restart` |
| V3 | 合并后迁移账本：`seed ... migrations --out <final-ref>` + `smoke-database --verify-migrations <final-ref> --database <restored-before DB>` | 0 / 0 | 空库 13 迁移、重复启动不变、冻结 0001+0004—0012、**0013 存在且为追加**、漂移/截断/失败回滚拒绝；恢复库账本 13 与参考一致、integrity/外键 ok |
| C1 | `capacity-repository`（合入后复跑） | 0 | 同 §2.1 #3（生产限额 2/10、429/幂等/409/租约） |
| C2 | 5 合成账号 HTTP 容量（首轮冷启动） | 0 | 5 账号登录 + 并行读 + 各自创建项目；无失败；最大单请求约 1244 ms（首次编译），非 SLA |
| C3 | 5 合成账号 HTTP 容量（热态复跑，保存于 `.superpowers/round6/capacity-http.json`） | 0 | **35 请求**：30×200 + 5×201，failures 0；延迟 min 11.85 / p50 144.55 / p95 256.37 / max 272.94 ms；wall 319 ms |
| B1 | `verify-round-five-browser.mts --base http://127.0.0.1:3000 --database <browser root> --username a5admin ...`（Edge headless） | 0 | **Round-five browser acceptance: 11 checks passed**（登录/建项预算/材料解析/字段登记/核验任务成功/partial 草稿/三个页签/核验两组状态/起草待核对/无页面错误）；截图 `.superpowers/round6/browser/` |
| T1 | `pnpm exec tsc --noEmit` / `pnpm exec eslint <A5 脚本>` | 0 / 0 | 合并后全工作树类型检查 0；本包 4 个脚本无 lint warning |

## 3. 备份集与恢复契约（实现口径）

- 备份集版本 1：`{version,kind,createdAt,appVersion,quiesced,database{file,sha256,size},root{database,objects,journal,sourcePaths},objects[{key,sha256,size}],journal{present,files[{name,sha256}]},migrationLedger,templates,publicationsGlobal,configNames,keyRecovery,notes}`。
- **只备份数据库不够**：原件/导出对象与删除日志必须同集备份；同一卷副本不是异地备份。
- 一致备份：要求停止应用写入；工具以 EXCLUSIVE 写锁作最后守卫（仍有写入即失败且不建输出目录）；数据库用 SQLite 一致快照（VACUUM INTO），对象逐字节按对象头 SHA-256 校验后复制；删除日志逐个文件复制并记录摘要。
- 恢复：只能到**新**路径；逐字节复核数据库/对象/日志；重放截至恢复时刻的最新删除日志（备份之后发生的删除允许作为更晚日志应用，脚本会记录 NOTE 并校验意图结构）；清除 `running` 在途任务为 `recovered` 队列并清空旧执行令牌/租约；墓碑行与删除记录保留，项目私有行/对象清除；已删项目恢复后列表不可见、内容访问统一拒绝（403 非成员/或 404），不得复活。
- 损失窗口：两次演练均为 **quiesced 备份**，备份快照到恢复之间已提交写入 **0**（实测写入损失 = 0）；生产 RPO 仍取决于备份频率，未承诺。
- 实测恢复耗时（本机合成）：演练 a 恢复复制 10 ms + replay 221 ms + 总 255 ms；演练 b 9 ms + 204 ms + 总 233 ms；HTTP 端到端验证 7.3—7.5 s（含 dev server 首次编译）。**不承诺 4 小时线上恢复目标或 SLA**。
- 外部缺项：真实 OBS 版本保护/桶权限/生命周期/跨实例、Linux 容器卷与 fsync、GaussDB、GitHub CI 运行、公网 HTTPS、ECS 外异地备份与 24 小时窗口均未验证；开发文件对象存储不是 OBS。

## 4. 容量两层 harness

- 仓储层（已执行）：生产 `taskLimits` 断言每账号未终结 2、全局排队 10；注入时钟/单飞租约下验证 429（每账号与全局，均不落库）、幂等重复、输入不同 409、租约过期恢复新 attempt、完成释放。测量值见 §2.1 #3。
- HTTP 层（已执行）：CLI 创建 5 个合成账号/项目管理员成员后，5 用户并行执行 6 项读（项目/详情/材料/成果/预算/任务）+ 各创建 1 个项目；热态 35 请求全部预期状态、0 失败，延迟见 §2.3 C3。仅本机合成测量，**不承诺 SLA/生产容量**。

## 5. 迁移账本

- 空库应用 13 迁移（含 0013）、重复启动账本不变、冻结 0001+0004—0012 摘要、0013 追加且纳入参考、历史漂移/编号缺口拒绝、失败迁移 schema+账本回滚；备份库/恢复库账本与 manifest/参考文件逐项一致，恢复库 integrity/外键通过。
- 0013（C7 两表）已注册并验证；0001—0012 未被修改（冻结摘要断言通过）。

## 6. 基线复核声明

- 第五轮已提交基线：`pnpm test` **919 项（918 pass / 1 skip / 0 fail）**、浏览器 11/11（见第五轮证据与计划）。
- 本轮按 Lead 约束**未运行** `pnpm check/test/build`（未重跑 919 基线，不把其当作本轮新结果）；浏览器 **11 项已在合入 C7 的树上实际复跑并 11/11 PASS**（§2.3 B1）。类型检查 `pnpm exec tsc --noEmit` 在合并树 exit 0。

## 7. 未运行项 / 外部缺项（不得声称通过）

- 未运行完整 `pnpm check/test/build/smoke`（由 Lead 集成门禁执行）；未运行真实模型/OCR/MaaS。
- 未验证真实 OBS 私有桶/版本保护/生命周期/跨实例一致性；未验证 GaussDB 真机（连接/TLS/迁移/恢复/并发）、Linux 容器非 root/卷 fsync/重启恢复；未运行 GitHub CI；未验证公网 HTTPS、ECS 外异地备份与 24 小时备份窗口。
- 未做真实项目数据恢复、未量化生产 RPO/RTO；本次只报告合成数据实测。Windows 目录 fsync 为已文档化的平台回退（文件 fsync+原子 rename 仍必需；Linux 逐级 fsync 为生产要求，未在本机验证）。
- 合成项目自动归档入口本轮未交付（计划已列为未运行）；在途上传→孤儿对象竞态残余记录未宣称零残留；删除状态 UI/C6 规范库 UI/C5 正文编辑/催款函不在本轮。
- 容量为合成本机测量，不是生产容量承诺；外部真实服务能力/配额/价格未验证。
- 未提交、未推送、未部署、未创建 Issue。

## 8. 协调与服务器生命周期记录

- C7（task-19）未合入前，共享工作树中的生命周期就绪门禁使项目 HTTP 入口返回 503；A5 先完成备份/恢复/容量仓储/迁移/文档工具与失败路径验证，未留后台进程。
- C7 合入（`4ac0d61`/`896cec3`）且 Lead 通知后执行完整演练：每个需要一致备份的时点先停止 dev server；DELETE 与恢复后 HTTP 验证期间运行唯一一个 managed dev server（127.0.0.1:3000）；每个 leg 结束即停止；最终确认 **端口 3000 空闲、无服务进程残留**。
- 本机服务日志：`.superpowers/round6/drill-seed-server.log`、`drill-delete-server.log`、`drill-restore-before-server.log`、`drill-restore-after-server.log`、`volume-server-1.log`、`volume-server-2.log`、`capacity-server.log`、`browser-server.log`（忽略目录，不作为产品证据）。
- 用户 A5 未提交文件：`scripts/seed-restore-project.mts`、`scripts/backup-objects.mjs`、`scripts/restore-verify.mjs`、`scripts/smoke-database.mjs`（改）、`docs/deployment.md`、`docs/operations.md`（改）、本文件；HEAD 为 Lead 的 `896cec3`，A5 未执行 git add/commit。

## 9. 交叉审查后修复（Lead 执行）

- **B3 修复**：`backup-objects.mjs` 的非敏感配置名清单原先只解析未注释的 `NAME=` 行，会漏掉 `PROJECT_DELETION_JOURNAL_DIR`/`PROJECT_RECLAIM_BATCH`/`PROJECT_LIFECYCLE_INTERVAL_MS`；现同时解析 `# NAME=` 示例行并合并冻结必需名单。`restore-verify.mjs` 新增 manifest 必填断言（appVersion/templates/configNames/keyRecovery 及 6 个恢复必需配置名）。
- 修复后实际复跑：`backup-objects.mjs` 对既有 seed 根生成新备份集 exit 0（31 ms，manifest `configNames` 已含 `PROJECT_*`）；`restore-verify.mjs --set <新备份> --restored-root <新根> --database/--objects/--journal` 离线恢复 exit 0（恢复复制 11 ms、总 28 ms，integrity/对象清单/日志/迁移账本/租约清理通过）。旧备份集因 manifest 缺这些字段会被新断言拒绝（符合 fail-closed）。
- **证据限制（如实）**：D9/D11 的 HTTP 22 项为演练时脚本输出，原始 stdout 未保存（已保存服务器日志、capacity JSON、浏览器截图与恢复根/备份集工件）；审查者独立复现了离线双向演练、15 项离线检查、浏览器 11/11、容量 JSON 与 CLI。最终验收记录不把 HTTP 22 项表述为可逐项复核的原始证据。
- **C7 证据更正**：C7 记录中 Windows 目录 fsync 的表述已按实际代码与复测改为“已文档化平台回退，reclaim --apply exit 0/reclaimed”，非平台故障仍 fail-closed；Linux 真实 fsync 保持未验证。
- **404/403 口径**：已删/未知项目的内容访问对非成员统一拒绝（403），不暴露存在性；超级管理员等路径按 404 语义。文档与证据统一使用“拒绝（403 非成员/或 404）”措辞。
