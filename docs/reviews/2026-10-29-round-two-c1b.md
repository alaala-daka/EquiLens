# C1b 后台执行授权验证

范围：Demo 技术基础，产品 §9 与 AC-15 的后台账号/项目重验部分。未计为完整业务验收。

2026-10-29，Windows、本地 SQLite/合成身份。后台入口 `authorizeTaskExecution` 仅读取当前启用账号、活动项目与成员角色；不读取 cookie、创建或续期会话。超级管理员仍需真实活动项目。不存在/已删除项目、缺失/禁用账号和权限不足统一 FORBIDDEN；底层故障返回固定 SERVICE_UNAVAILABLE。

实际执行：

- RED：`pnpm exec tsx --test src/server/projects/execution.test.ts`，exit 1，2 项因缺少工厂失败。
- GREEN：`pnpm exec tsx --test src/server/projects/*.test.ts`，exit 0，14/14 通过（含新增 3 项）。真实 SQLite 验证退出后账号读取、角色维护、禁用与未知账号；注入仓储验证角色降级、成员移除、项目删除和数据库失败。
- `pnpm check`，exit 0，ESLint、路由类型与 TypeScript 通过。
- `git diff --check`，exit 0。

未执行：runner 联验、真实 GaussDB、外部请求撤权联验与完整 AC-15；由消费者在每阶段/外发前调用，返回值不能缓存为长期权限。
