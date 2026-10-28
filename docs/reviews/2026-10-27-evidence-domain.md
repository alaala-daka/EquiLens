# 证据整理领域层（B4 第一批）

日期：2026-10-27。分支：`feat/evidence-organization`（独立 worktree：`.worktrees/evidence`）。未提交、未推送、未登记迁移编号。

## 范围

按 B4 先交付可离线验证的领域层，不开放真实接口：

- 证据项独立于款项表保存，可先记录材料事实，再按不可变版本关联事实/款项/条款/争点；未关联时显式 `pendingLinks`，不填占位 ID。
- 证据性质、确认状态、证据状态分开保存；冲突来源与「已确认」并存时仍保留冲突。
- 报告版本固定：时间线、争点、证据对应表、缺证项、有条件建议、引文与版本摘要；页面与 Markdown 导出同一版本。
- 跨项目来源/关联拒绝；重复附件引用、旧来源、金额浮点串、篡改版本摘要均拒绝。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/lib/evidence/types.ts` | 证据项、来源引用、关联、报告、错误类型 |
| `src/server/evidence/validation.ts` | 输入校验、项目范围、来源/关联解析器接口 |
| `src/server/evidence/report.ts` | 报告组装、状态与范围提示、Markdown |
| `src/server/evidence/schema.ts` | 模块表结构（**未登记迁移**） |
| `src/server/evidence/repository.ts` | 不可变版本、摘要校验、项目隔离 |
| `src/server/evidence/service.ts` | 注入 `EvidenceScope` 后保存证据/报告 |
| `src/server/evidence/fixtures.ts` | 正常/冲突两个合成案例 |
| `src/server/evidence/evidence.test.ts` | AC-06—AC-10、AC-19 行为测试 |

规格同步：`spec/01-product.md` §4.5、`spec/02-workbench-ui.md` §5.7。

## 验证

在本 worktree 执行：

```bash
node ../../node_modules/tsx/dist/cli.mjs --test src/server/evidence/evidence.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit
node ../../node_modules/eslint/bin/eslint.js src/server/evidence src/lib/evidence --max-warnings 0
```

结果：测试 5/5 通过；`tsc` 通过；ESLint 0 error / 0 warning。

覆盖：正常证据链与 Markdown、冲突+开放缺口保持 `incomplete`、重复附件/旧来源/浮点金额/跨项目拒绝、人工更正另存版本且旧报告可读、跨项目读取与摘要篡改拒绝。

## 待集成（非本批）

1. 共享 `SourceRef`、`FactItem`、`PaymentLedgerRevision` 类型落地后替换本地结构类型；关联字段严格使用 `{factVersionId,factId}`、`{ledgerRevisionId,rowId}`。
2. `EvidenceScope` 由共享事实/款项/来源仓储实现；接入前不开放 API 路由。
3. 迁移编号由整合方登记；`schema.ts` 的 DDL 直接并入，不改全局注册表。
4. `src/components/business/mainline/evidence-view.tsx` 与任务/成果入口、A4 复核/导出尚未实现。
5. 未做真实项目权限、登录、并发保存合并、DOCX/PDF 附件和浏览器验证。
