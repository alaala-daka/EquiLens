# 多 Agent 主线加固验证

日期：2026-10-25。阶段：Demo 授权联调。范围：多 Agent 主线（`multi-agent-v1`）的代码加固；不改变场景登记、规则内容、模型提示与预算上限。

## 修复

- **主审封存条件**：新增 `hasCheckedRange`（`tools/contract-review/src/validate.ts`），以"检查范围非空"判断实质结论；`agent/pipeline.ts` 与任务仓储 `claim`/`finish` 同步使用。此前 `findings.some(item => item.checkedParagraphIndexes)` 会把空数组判为真：模型只加载技能、不读正文就提交"待核实"时，主审会被误判为已封存，恢复永久跳过主审，复核再对占位项批量"保留"并计入已复核。
- **复核范围**：后端为未答必检项补录的条目增加 `placeholder` 标记（`types.ts`、`agent/session.ts`）。复核只核对模型给出的实质结论，`agent/audit.ts` 以未标记条目组建批次；占位项始终留在未复核清单，任务因此不能显示复核完成。
- **复核失败隔离**：复核输入或摘要校验失败时清空可疑的旧复核结果（`pipeline.ts`），不再继续展示或再次持久化被拒绝的数据。
- **任务层回归**：新增 `src/server/contract-review/tasks/runner.test.ts`，注入仓储与模型传输真实执行 `multi-agent-v1` 任务，覆盖路由→主审→复核顺序、累计预算、封存与拒绝路径。执行逻辑拆到无 `server-only` 的 `tasks/workflow.ts`；`runner.ts` 只保留调度、心跳与取消。
- **构建上下文**：`.dockerignore` 排除 `tools/contract-review/output/`，避免本地 CLI 报告（含合同原文）进入镜像构建上下文。
- **文档口径**：`spec/00` 明确原始模型交换保存为任务工件、不并入报告 JSON；`DEVELOPMENT.md` 收窄本机 `.env.local` 模型联调授权范围；自动场景识别记录补充"截至本记录"的场景范围说明。

## 工程验证

Windows / Node.js 24.16.0 / pnpm 11.6.0：

- `pnpm check`：ESLint、Next.js 路由类型与 TypeScript 通过。
- `pnpm test`：230 项，229 通过、0 失败、1 项既有 Linux 文件/目录 fsync 检查在 Windows 跳过（原 227 项 + 本次 3 项）。
- `pnpm build`：standalone 生产构建通过。
- `git diff --check`：通过。

本次未调用真实模型，不新增业务样本；真实模型成本与四场景全流程验收仍以 [多 Agent 与四场景主线验证](2026-10-25-multi-agent-mainline.md) 为准，不因本次代码修复而升级结论。
