# 合同审查定向取材验证

日期：2026-10-22。范围：[条款块与定向取材](../../spec/00-overview.md#条款块与定向取材)，
计划见[优化计划](../contract-review-optimization-plan.md)。

## 环境

Windows，Node.js 24.16.0，依赖为仓库已锁定的版本。全部使用合成合同与模型桩，
未调用真实网关，未使用真实合同材料。

当前目录路径含中文括号，`pnpm` 启动时在 `safe-delete` 步骤失败退出，因此本次直接调用
`node node_modules/tsx/dist/cli.mjs --test`、`node_modules/eslint/bin/eslint.js` 与
`node_modules/typescript/bin/tsc`。`pnpm` 本身的异常另行处理，不影响下述结果。

## 已执行

- 改造前基线：主应用 30 项、合同审查 28 项，共 58 项通过；ESLint `--max-warnings 0` 与
  `tsc --noEmit` 均为 0 错误。
- 改造后全量：69 项通过（新增 `segments.test.ts` 6 项、`focused.test.ts` 5 项）；
  ESLint 与 TypeScript 仍为 0 错误。
- `--dry-run` 用 `tools/contract-review/fixtures/sample-contract.txt` 验证：18 段切成 9 块，
  目录按「第X条」输出；带 `--role 专业分包人 --project-type 房建机电安装专业分包 --region 上海`
  时 18 条规则全部进入计划。

新增测试覆盖的行为：

- 切块后段落编号不重复、不遗漏，表格段落保留行列编号。
- 无编号文档按段落边界切分，不切断段落内部。
- 约三万字合同在整篇模式下触发 `REVIEW_INPUT_TOO_LARGE`，改为定向取材后可以完成审查。
- 定向提示只含目录与相关块，未命中段落不出现在提示中，长度低于 12,000 字符。
- 定向模式仍逐字校验引文，编造引文全部进入 `rejected`，状态为 `failed`。
- 非必检规则未命中线索时记入 `notLocated`（`no-match`），状态不为 `success`，
  Markdown 报告出现「未定位的检查项」。
- 定向模式没有正文线索时仍送目录，记入 `outline-only`，不声明已检查全文。

## 未执行

- `pnpm build` 与容器构建：本次未运行。
- 真实模型调用与真实合同审查：未运行；模型名、上下文预算与提示上限仍未经实测。
- 页面接入、HTTP 路由、任务持久化：不在本次范围。
- GaussDB 真机、OBS、OCR：未涉及。

## 结论与限制

定向取材解决了「整篇超限直接失败」这一确定缺陷，并把「没查」变成可读的记录。
测试通过只说明上述编排行为符合预期，不构成 AC-03、AC-21、AC-23 或任何业务准确率验收。

提示上限仍为未验证的保护值；正式开放前须按 `spec/01-product.md` §2 实测模型容量并固化配置。
