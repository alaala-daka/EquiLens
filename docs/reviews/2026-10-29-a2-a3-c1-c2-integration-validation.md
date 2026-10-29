# A2 / A3a / A3b / C1 / C2 并行集成验证记录

日期：2026-10-29（Asia/Shanghai）。分支：`develop-after/a2-a3-c1-c2-integration`。
基线：`207f59d`（DOCX 结构往返合并后）。本次未推送、未部署、未创建 Issue。

## 范围

按 C0 冻结接口并行完成：

| 线 | 工作包 | 提交 |
| --- | --- | --- |
| C0 | 共享业务契约 `src/lib/business/contracts.ts` | `eae81c6` |
| A | A2 编辑器访问接口 + 未保存登记 | `2704dfb` |
| C | C1 项目/成员/三角色授权 + 工作台宿主 | `0490b0a` |
| A | A3a 任务提交/幂等/准入 + A3b 持久预算预留 | `9226f32` |
| C | C2 私有资料/解析快照/来源服务/OBS 接口 | `436db69` |
| 集成 | 迁移 0004—0006 与 checksum 冻结 | `7600541` |
| 集成 | 默认测试命令纳入新目录 | `fdcda1a` |
| 文档 | spec/01 §3.4、spec/02 §5.1 等项目/材料契约 | `702d875` |

C0 由 Lead 冻结，A/C 消费；乙侧会签仍未完成。`src/server/database/migrations.ts` 的 0004 projects、0005 tasks、0006 materials 已注册，0004—0006 的 checksum 已加入测试冻结。

## 实际执行

在 Windows、Node.js 24、pnpm 11.6.0、SQLite 本机环境执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | exit 0（ESLint + 路由类型 + TypeScript） |
| `pnpm test` | 521 项：520 通过、0 失败、1 跳过（Linux 文件系统持久性） |
| `pnpm build` | exit 0（standalone 构建） |
| `pnpm smoke http://127.0.0.1:3000` | 通过 health、首页、样式、公共资源 |
| 浏览器（Edge + Playwright） | 匿名工作台 → 登录 → 页头显示项目/角色/账号 → 项目菜单 → 退出回 `/login`；无 page error |
| 本地 SQLite | 已应用 0001—0006；projects/members/tasks/budgets/materials/snapshots/sources 表存在 |

定向测试（实际执行）：

- `src/server/tasks/{catalog,repository,budget,http}.test.ts`：48 通过、0 失败。
- `src/server/projects/{service,http}.test.ts`、`src/server/materials/*.test.ts`、`src/server/storage/obs.test.ts`、`src/server/database/migrations.test.ts`：37 通过、0 失败。
- `src/lib/documents/*.test.ts`（A2 回归）：126 通过、0 失败。
- `src/components/business/platform/request-gate.test.ts`：4 通过、0 失败。

## 本轮修复的实际缺陷

- A2 抽取后仍保留匿名 operationId/baseRevision/字节/错误语义；新增未保存登记的单飞、部分失败与重复保存保护。
- C1 项目切换与 focus 刷新共用请求门导致 `switching` 永久为 true；拆为独立 request gate，切换中刷新不再使切换失效。
- A3b 终态/恢复路径不结算预算预留导致额度永久占用；新增 token-free 终态结算，在 claimNext 放弃 attempt 与 finish 前同事务结算，并冻结 0005 不变。
- 迁移历史测试按 0004—0006 追加调整，同时增加校验和冻结断言，防止已应用迁移被静默改写。
- 解析/材料/任务相关测试与 `pnpm check`/`pnpm build` 全绿。

## 未运行 / 未通过项（不得计入验收）

- A3c 单一全局 runner、claim 前 authorizeClaim、`/api/tasks` 路由与预算 HTTP/UI 未实现。
- A4 共享成果/复核/导出、A5 平台与 GaussDB 首闭环未实现。
- C2 解析仍在主进程内执行，未使用 512 MiB / 60 s 受限子进程；`put` 与数据库提交之间的崩溃残留尚未落上传意图；真实 OBS 适配器仍为 fail-closed。
- C3 项目 Word 适配、编辑器页头项目显示、上传 HTTP 未实现；C4—C7 未开始。
- B1—B5 主线未开始；C5/C6 依赖乙的事实、规则与催款函模板。
- GaussDB、OBS、OCR、MaaS 均无真机验证；无公网 HTTPS、容器恢复或完整项目恢复记录。
- A1 下游签收、C0 乙侧会签、AC-01/AC-15 与 UI-14/15 的联合验收未完成。
- 项目创建权限：spec/01 §3.4 采用“已登录账号可创建并成为管理员”，与 §3.1 角色表“项目管理员创建”的措辞仍需产品确认。

## 结论

本轮 A2、A3a、A3b、C1、C2 的本地实现与 SQLite 验证可合并为下一阶段基线；**不代表 A3/A4/A5、C3—C7、B 线或外部服务验收通过**。下一步按 A3c → A4、C2 前置 → C3，再进入 B2—B5 与其余业务。
