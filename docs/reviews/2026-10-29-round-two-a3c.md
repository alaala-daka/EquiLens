# A3c 本地验证记录

日期：2026-10-29。阶段：Demo 共用基础；状态：已实现待交叉审查。

## 实现

统一 runner 先领取通用任务，空闲时执行匿名审查，共享单飞槽。既有匿名 runner 导出改为兼容包装。Node instrumentation 显式启动；导入不启动循环。通用任务领取后及执行器 refreshAccess/付费预算边界重新检查后台项目授权。撤权返回 ACCESS_REVOKED，异常消息固定，不泄露原始错误。15 秒心跳、执行令牌及恢复约束复用现有仓储；心跳请求单飞。

新增任务执行器注册表；未注册类型在 submitTask 入口返回 503，不写入任务。新增 /api/tasks 与 /api/tasks/[id]，复用现有身份、项目授权、同源、幂等键、256 KiB 流式限制和私有 no-store HTTP 适配。

预算估价使用 catalog 固定预算除以最大调用数向上取整，时间占用 90 秒；这是保守预算，不是供应商报价。runner 忽略执行器提供的价格，使用服务端估价；零付费调用类型拒绝预算预留。

## 实际检查

- red-first：新增 runner-core.test.ts 后执行定向测试，exit 1，Cannot find module ./runner-core；然后写实现。
- `pnpm exec tsx --test src/server/tasks/*.test.ts src/server/contract-review/tasks/runner.test.ts src/server/contract-review/tasks/revision-only-task.test.ts src/server/contract-review/tasks/scene-reselection.test.ts`：exit 0，53 tests / 53 pass / 0 fail。原始输出 `.superpowers/a3c-targeted.txt`（忽略文件，包含合成测试结果）。覆盖新撤权/串行停止、估价/注册表，以及已有预算、租约恢复、旧令牌、HTTP、匿名审查回归。
- `pnpm check`：首次实现后 exit 0；最终再次运行亦 exit 0。`git diff --check` exit 0。另新增停止期间领取竞态测试，定向 runner-core 3/3 pass，exit 0。

## 未执行与边界

没有发布、部署、真实 MaaS/OCR/OBS 调用、GaussDB 或法律质量验收。material-parse 注册由 C2b 在明确生命周期提供，当前注册表默认空，生产提交安全拒绝。未运行浏览器任务接口实测、完整容器和生产构建；由 Lead 串行集成门禁覆盖。现有 HTTP 工厂测试使用注入服务，不等同于实际路由端到端。后台账号禁用、项目删除、移除成员的具体读取由 C1b 测试证明，本包测试模拟授权拒绝。

## A3c review revision

修复 HTTP 原始 body 顶层字段白名单；模型、价格、预算、执行器及 body operationId 等额外字段返回 422，提交服务不会被调用。后台授权只把明确 FORBIDDEN/NOT_FOUND/UNAUTHENTICATED 映射为 ACCESS_REVOKED；SERVICE_UNAVAILABLE 保留，未知异常归 EXECUTION_FAILED，不误报撤权。

测试先行：新增上述 HTTP 与授权故障测试，首次 2 项失败（422 实得202；SERVICE_UNAVAILABLE 实得ACCESS_REVOKED），原始记录 .superpowers/a3c-revision-red.txt。修复后 `pnpm exec tsx --test src/server/tasks/http.test.ts src/server/tasks/runner-core.test.ts` 10/10 pass，exit0，原始记录 .superpowers/a3c-revision-green.txt。随后运行 pnpm check，结果见交付消息。
