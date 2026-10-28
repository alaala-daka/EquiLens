# 模型端点兼容验证

范围：架构规格 MG-01—MG-05，当前 `askModel` 与 `ToolLoopAgent` / `createAgentModel` 两条客户端路径。
离线测试使用合成 HTTP 响应，不访问供应商，不计为真实端点兼容或法律业务验收。

## 实现与边界

- `pnpm ai:compat` 是显式真实调用，读取本机环境配置，发送固定连通消息和一份微型合成付款条款；合计最多两次请求、每客户端一次，不自动重试或修正。
- Agent 样例走实际 SDK、受限提交工具与严格 schema；不强制命名 `tool_choice`，保留当前端点 thinking 模式所需的普通工具选择方式。
- 输出 JSON 仅含检查时间、端点主机、模型、客户端、调用次数、耗时、结束原因、已知用量及脱敏错误码。缺失用量记为 `null`，不当作零消耗。不会输出模型正文、合同、密钥或请求头。
- 结果只适用于该次实际配置的端点、模型和所测功能。未配置及未运行的 GLM、DeepSeek 或其他端点不标记为兼容；本文件不预填真实通过结果。
- 工具信封必须包含有效且不重复的调用 ID、`type=function`、函数名及字符串参数；`stop` 不能同时携带待执行工具。先保留响应证据，再拒绝非法信封，不提交正文交付记录。
- 参数为空、非 JSON 或不符合业务 schema 时，由实际 SDK 记录无效调用且不执行工具；既有有界参数纠正仍受原次数与时间预算约束，不因兼容改动无限重试。

## 离线验证

已执行：

```powershell
pnpm exec tsx --test src/server/ai/client.test.ts src/server/ai/compatibility.test.ts tools/contract-review/tests/agent-model.test.ts tools/contract-review/tests/agent-compatibility.test.ts tools/contract-review/tests/prepared-review.test.ts
```

24 项通过，0 失败。覆盖纯文本正常、截断、空内容、refusal、缺失/非法 usage；实际 ToolLoopAgent 的正常工具调用、畸形信封、重复 ID、结束原因矛盾、空/非 JSON 参数及长度截断；保留 prepared 主审原有有限纠正。

修复前新增用例复现：畸形工具信封在 SDK 拒绝前已触发 `afterResponse`；修复后该回调不执行，仍保留本次交换记录。

真实执行时可将以下命令的 JSON 输出保存到本机忽略目录，再据实际结果补充验证记录：

```powershell
pnpm ai:compat
```

文本及工具两个阶段必须分别查看；一个阶段成功不能代表另一个阶段成功。兼容冒烟只核对微型材料和传输/结构行为，不代替完整合同、来源适用性或业务准确率验证。

## 当前配置实测

2026-10-28 对本机 `.env.local` 当前配置执行了 `pnpm ai:compat`，只发送合成文本和微型合成付款条款：

| 阶段 | 端点主机 | 模型 | 结果 | 调用 | 已知 token | 结束原因 | 观察耗时 |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| `askModel` | `api.deepseek.com` | `deepseek-flash` | 通过 | 1 | 59 | `stop` | 852 ms |
| `ToolLoopAgent` | `api.deepseek.com` | `deepseek-flash` | 通过 | 1 | 645 | `tool_calls` | 1,268 ms |

结论仅限这次实际配置的端点和模型；没有测试 GLM、其他 DeepSeek 模型或其他供应商，不能据此声明兼容矩阵通过。耗时包含本机网络，不作为供应商延迟基准。
