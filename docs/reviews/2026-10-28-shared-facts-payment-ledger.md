# 共享事实与款项表版本（领域层）

日期：2026-10-28。分支：`feat/document-agent-web`。未推送、未开 PR。

## 范围

先把“共享事实”和“款项表版本”做成可测试的领域层，不接网页任务、项目权限和 UI：

- 事实：稳定 `factId` + 不可变 `factVersionId`，按项目/合同/字段/期间保存；人工更正生成新版本，保留原值、理由、人员和来源。
- 事实性质（材料记载/人工陈述/拟约定/程序计算）、确认状态、证据状态分开；人工确认不清除材料冲突。
- 款项表：稳定 `ledgerId` + 不可变 `ledgerRevisionId`，行级 `rowId`、金额性质、本期/累计、税口径、到期条件、付款归属、来源和事实版本引用。
- 金额只接受整数分字符串；计算按已确认行、同一期间/税口径/主体，重复付款去重，负余额保留负值。
- 版本保存使用基础版本乐观并发；旧版本不可覆盖，读取按项目隔离并校验摘要。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/lib/facts/types.ts` | SourceRef、FactInput、FactVersion、FactError |
| `src/server/facts/validation.ts` | 来源、性质、确认/证据状态、更正理由、重复来源校验 |
| `src/server/facts/repository.ts` | 事实版本表、摘要、乐观版本、项目隔离 |
| `src/server/facts/facts.test.ts` | 版本链、冲突保留、跨项目、篡改 |
| `src/lib/payments/types.ts` | LedgerRow、LedgerInput、PaymentLedgerRevision |
| `src/server/payments/validation.ts` | 行校验、整数分、期间/税口径、计算、去重、负值 |
| `src/server/payments/repository.ts` | 款项表版本、基础版本、计算快照 |
| `src/server/payments/payments.test.ts` | 500,000 元、重复付款、负余额、旧版本、跨项目 |
| `src/server/document-agent/projection.ts` | 把款项/证据结果投影为事实版本；款项任务另生成款项表版本 |
| `src/server/document-agent/projection.test.ts` | 投影事实/款项版本、500,000 元、证据只生成事实 |

## 验证

```bash
pnpm test
```

结果：315 项，314 通过、1 平台跳过、0 失败；`pnpm check`、`pnpm build` 通过。

## 投影服务

`projectDocumentAnalysis` 接受明确的 `projectId` 和文档版本，把整理结果写成：

- 每条金额 → 一个 FactVersion，并保留 source 段落/引文
- 款项任务的金额同时映射为 LedgerRow，生成 PaymentLedgerRevision，计算余额
- 证据事件 → FactVersion（材料记载/人工陈述、支持/冲突状态）
- 返回 `factVersionIds` 与 `ledgerRevisionId`，供证据/催款函后续引用

## 尚未接入

- 投影服务尚未由任务工作流调用，也没有 HTTP/UI；`projectId` 必须由未来项目上下文提供，不能用匿名 owner 冒充。
- 没有项目成员校验；项目权限属于后续第 3 项。
- 只做来源结构校验，未验证来源是否真实存在于文档仓储。
- 证据/催款函结果还没有写回 `factVersionIds`/`ledgerRevisionId` 引用。
- 款项计算是当前 Demo 口径，不覆盖所有期次、扣抵和资金归属场景。
