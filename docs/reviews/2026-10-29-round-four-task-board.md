# 第四轮共享任务板（C4 投标材料核验）

基线 `alaaladaka/round3/review` @ `c74a2c2`；集成分支 `alaaladaka/round4/verification`。
计划：[第四轮计划](../superpowers/plans/2026-10-29-round-four-plan.md)（经独立审查并修订，审查报告在忽略目录）。
本文件记录执行状态，不表示验收通过；状态只按实际命令/测试/证据更新。

## 工作包状态

| 包 | 主写者 | 范围 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| W0 | Lead | 规格、字段词表/归一化、catalog 三拆、admission、0010、field-source、ResultService/access、exports 保留期 | 基线 | 已提交（`c9ac2bb`；`pnpm check` exit 0；catalog/migrations/results/exports 定向测试通过；全量 682 测试 681 通过/1 skip/0 fail） |
| C4-OCR | Agent A | OCR 边界、图片材料门控、certificate-ocr 执行器、字段插入式历史与接口 | W0 | 已完成（未提交；定向 91/91，reviews 34/34，tsc 0；证据 `2026-10-29-round-four-c4-ocr.md`） |
| C4-VERIFY | Agent B | 要求候选、受控要求集保存、确定性比较、两类成果与导出、外部核验记录、HTTP | W0 | 已完成（未提交；定向 106/106 含跨包与闭环；tsc 0；证据 `2026-10-29-round-four-c4-verify.md`） |
| Review | 交叉审查 Agent | 独立核对两包实现与证据 | A、B | 已完成：APPROVE WITH FIXES；2 blocker + 高价值项已修复，复核中（报告 `.superpowers/round4/cross-review.md`） |
| I1 | Lead | 集成、注册接线、门禁、无外部服务闭环、证据、提交 | A、B | 已完成本地门禁：`pnpm check` 0、`pnpm test` 796/795+1skip/0、`pnpm build` 0、smoke 通过、E2E 22/22、`git diff --check` 0；证据 `2026-10-29-round-four-integration.md`；待提交 |

## W0 冻结接口（实现以此为准）

- 任务类型（`TASK_CATALOG_VERSION = 3`）：`bid-requirements`（maxCalls 2，refs `{materials}`，conditions `{asOf?, externalProcessingConsent:true}`）、`certificate-ocr`（maxCalls 2，refs 恰好 1 个材料，conditions `{certificateKind:string, externalProcessingConsent:true}`）、`bid-verification`（maxCalls 0，refs `{materials, requirementSet{id,versionId,sha256}, externalRecords[{recordId,sha256}]?}`，conditions `{asOf}` 必填）。
- 准入：`src/server/tasks/admission.ts` 的 kind 级钩子，在入库前执行；OCR 不可用/证照种类未实测时 `certificate-ocr` 503 且不入库。
- 字段词表/归一化/引文匹配：`src/lib/business/verification-fields.ts`（A、B 必须共用）。
- 字段读取接缝：`src/server/verification/field-source.ts`（A 实现，B 消费；仅当前值）。
- 迁移 0010：`equilens_ocr_runs`、`equilens_verification_fields`（插入式历史，`subject_key`/`revision`/`previous_id`/`superseded_at`）、`equilens_verification_records`（追加式，含 `sha256`）。
- 成果：`bid-requirements` 与 `bid-verification` 均为 machine-only；`bid-requirements` 追加 server-owned 人工确认保存（`VerificationService.saveRequirementSet` → `ResultService.saveResultRevision(..., undefined, { serverOwned: true })`，浏览器不可达）；`bid-verification` 重跑产生新 resultId。
- 导出：`bid-verification-report-v1`（Lead 登记）；`bid-requirements` 无导出模板；导出保留期包含结果依赖中的 material 版本。
- OCR：默认 fail-closed；合成替身仅测试文件；图片 4 MiB/8192 px/40 MP；图片不进入 material-parse；上传意图不得被修复扫描重投解析。

## 冻结写作用域

- Agent A：`src/server/verification/ocr*`、`src/server/materials/**`（图片门控/限制/意图/防御）、`src/lib/business/materials-client.ts` 宽化、`src/server/reviews/input.ts` 最小图片过滤、字段路由；证据文件。
- Agent B：`src/server/verification/{types,requirements,compare,validation,records-repository,executor,input,extractor,service,http,access,runtime,export-template}.ts`、`src/lib/business/verification-types.ts`、`/api/projects/[id]/verifications/**`；证据文件。
- Lead：spec、共享类型/词表、catalog/admission、migrations、schema/field-source、results/exports 注册与保留期、instrumentation、package.json、门禁与提交。

## 迁移编号

0001—0009 摘要不变；0010 = C4 核验（三表）。0011—0013 仅为后续轮次规划意图，不预注册；B1a/B3a 在 B 线实施时取当时下一连续编号并迁入迁移账本。

## 未决与外部门槛

- 真实 OCR 账号/实测种类/价格：未验证；生产 fail-closed，图片默认拒绝，AC-02 OCR 条款与 AC-04 图片路径保持未通过。
- 领域要求标注与规则签核：未完成；AC-04 业务正确性、AC-08/AC-22 整项不做通过声明。
- 权威外部查询 API、真实 GaussDB/OBS/MaaS、公网 HTTPS、CI 运行、Docker/Linux：保持外部缺项。
- 本机持久开发库若已应用 0010，后续不得修改 0010 内容；需要时重建开发库。
