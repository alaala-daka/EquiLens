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

## 验证

```bash
pnpm test
```

结果：313 项，312 通过、1 平台跳过、0 失败；`pnpm check`、`pnpm build` 通过。

## 尚未接入

- 没有 HTTP API、页面或项目成员校验；`projectId` 由调用方传入，项目权限属于后续第 3 项。
- 只做来源结构校验，未验证来源是否真实存在于文档仓储。
- 文档 Agent/证据/催款函尚未改为引用 FactVersion/PaymentLedgerRevision。
- 款项计算是当前 Demo 口径，不覆盖所有期次、扣抵和资金归属场景。
