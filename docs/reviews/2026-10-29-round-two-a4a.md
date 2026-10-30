# A4a 共享成果机制验证（待交叉审查）

范围：第二轮计划 §4.4、A4a，产品 §8.1、§8.2.1；无 UI、无真实业务生产者。生产校验器注册表为空，保存、重验与复核对未注册类型返回 SERVICE_UNAVAILABLE；测试类型仅定义在测试文件。

## 接口

`ResultService(repository, registry)`：saveResultRevision(identity, authorize, input[, machine])、validateResult(identity, authorize, ResultRevisionRef)、reviewResult(identity, authorize, ReviewInput)、get/list。精确类型见 src/server/results/service.ts。

SaveResultInput：projectId/resultId?/kind/baseVersionId/operationId/reason/value/sources/dependencies。空 baseVersionId 仅用于新成果。HTTP 路径固定项目与成果，拒绝 origin/machineOutput；机器发布参数仅由服务器传入 output/taskId/attempt/executionToken，在写成果的同一事务条件更新运行任务，校验项目、账号、尝试、令牌和未过期租约。机器写入只创建新成果，不能覆盖已有人工结果；人工作业继承独立机器原文。

0007 所有五表位于 results/schema.ts，包含 exports 预留对象键、快照、摘要、模板/渲染版本及替代关系。尚待 Lead 注册与 checksum 冻结；未修改共享迁移。

## 实际命令结果

初始 RED：`pnpm exec tsx --test src/server/results/validation.test.ts` exit 1，MODULE_NOT_FOUND ./validation（先写测试）。

最终定向：`pnpm exec tsx --test src/server/results/*.test.ts` exit 0：

```text
✔ immutable revisions, idempotency, review reset, stale and permissions
✔ invalid citation cannot be approved and decimal amount text is preserved
✔ machine attempt token is checked transactionally; generated retries cannot overwrite human revisions
✔ operation hashes distinguish values but ignore object key order
✔ unregistered production result types fail closed
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ skipped 0
```

`pnpm exec eslint src/server/results "src/app/api/projects/[id]/results"` exit 0，无输出。
首次 `pnpm exec tsc --noEmit` exit 0；并行修改后的后续运行报告 C2 upload-intents.test.ts:75/76 类型错误，未修改他人文件。`git diff --check` exit 0（执行时）。

## 限制与审查项

未执行全量 test/build/smoke、GaussDB 或 CI。HTTP 工厂已实现并挂载五组路由，尚无 HTTP 行为测试；机器写入与任务终态为两个事务，但发布时持有任务条件更新行锁，失效尝试无法发布，且机器发布绝不更新已有成果。无真实业务验证器/渲染器；业务字段、缺证与冲突依赖固定服务端验证器，基础层另核对片段归属、快照和引文。生产消费者接入前必须提供并审查真实验证器。A4b 未启动。

## A4a 复审修复

Important 1：新增不可变 `provenance_json`。机器发布在持有任务条件更新行锁后，从任务可信行读取 manifest/manifest_hash，并保存 taskId/attempt/manifest/manifestHash；HTTP 不接受 provenance 等额外字段。人工修订继承机器来源。测试将任务标记完成、改尝试/令牌及manifest后重新读取成果，仍得到原输入清单；失效令牌与覆盖人工结果保持拒绝。

Important 2：新增 HTTP 工厂测试，覆盖私有缓存、认证401、AUTH_BUSY/AUTH_UNAVAILABLE503、只读和撤权拒绝、项目/成果路径冲突、Origin、格式/JSON/数组/未知字段/缺字段/超限请求、无效引用批准拒绝及未知异常不泄露。HTTP 的认证故障映射已修正。

修复验证原始摘要：
```text
pnpm exec tsx --test src/server/results/*.test.ts
✔ result HTTP enforces private scope, authorization, strict writes and safe failures
✔ immutable revisions, idempotency, review reset, stale and permissions
✔ invalid citation cannot be approved and decimal amount text is preserved
✔ machine attempt token is checked transactionally; generated retries cannot overwrite human revisions
✔ operation hashes distinguish values but ignore object key order
✔ unregistered production result types fail closed
ℹ tests 6
ℹ pass 6
ℹ fail 0
```
该命令 exit 0。HTTP测试首次以HTTP测试源运行受认证配置拒绝，调整为HTTPS测试源；其后测试以不合法完整ResultView作为review请求受到严格字段拒绝，改用实际ReviewInput字段。最终结果如上。

`pnpm check` exit 0（ESLint、Next route type generation、tsc）；未运行 build/smoke/全量test/CI。0007仍由Lead注册、冻结，A4b未开始。已通知A4b消费者核对exports字段和读取接口。待复审。

### A4b 消费接口最小补充

ResultView 新增 sources/dependencies：分别读取所选不可变版本的 sources_json，以及按 project/result/version 共同过滤的依赖行。无 schema 修改。读取测试验证历史来源和依赖仍读取保存值。

`pnpm exec tsx --test src/server/results/*.test.ts` exit 0，6 tests / 6 pass / 0 fail；`pnpm exec eslint src/server/results` exit 0，无输出。已通知 A4b 与复审者。
