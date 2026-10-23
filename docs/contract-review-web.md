# 网页合同审查与任务交接

## 使用

1. 根目录安装锁定依赖，登记 ANONYMOUS_DATA_RETENTION_DAYS；在忽略的 `.env.local` 填写 AI_BASE_URL、AI_MODEL、AI_API_KEY。
2. `pnpm dev` 自动打包 DOCX 子进程解析器，Node.js instrumentation 启动任务执行器。
3. 导入基础 DOCX，或打开已有文档；修改后先保存。
4. 在右侧「合同审查」确认立场、项目类型、地域、发送目标、记录保留时长及外发授权。
5. 开始后显示真实阶段和已读数量；页面关闭不取消任务。返回文档页或重新打开文档查看历史。
6. 点击引文查看任务固定版本的解析原文。取消阻止后续调用；继续原任务不重置预算或期限。

网页目前只接 DOCX，TXT 继续走 CLI。当前会话隔离不是账号/项目成员授权，丢失 cookie 后不能凭任务 ID 取回资料。
已有未保存更改不会被发送，也不会因审查自动改写合同。报告全部待人工复核。

## 配置

| 配置 | 含义 |
| --- | --- |
| AI_REVIEW_MODE | 后端固定 published/debug；开发默认 debug，生产默认 published |
| AI_REVIEW_RETENTION_DAYS | 任务及派生记录固定保留天数，1–365；开发默认 7，生产必配 |
| AI_REVIEW_MAX_PROMPT_CHARS | 单次完整序列化请求上限；调试默认 240000，正式模式须显式配置经验证的值，范围 1000–240000 |
| AI_AGENT_MAX_CALLS | 原任务累计请求上限，默认 25，可配置 1–25，跨重试/恢复不清零 |

内置规则尚未发布，published 模式会拒绝提交。debug 必须在网页明确确认未核对资料，报告保持该标记。
模型地址和名称在提交时固定，运行时仅从环境读取密钥；更换密钥不需要把凭据存入数据库。
生产需要常驻单实例 Next.js Node.js 容器及持久数据库，不使用会随请求结束退出的 serverless 任务运行方式。

## 代码与接口

- `src/server/contract-review/tasks/`：配置、输入固定、任务仓储、受限 JSON 处理、执行器。
- `src/instrumentation.ts`：明确 Node.js 生命周期启动，不在模块导入或构建时启动执行。
- `src/lib/contract-reviews/`：共享线类型及浏览器请求。
- `src/components/contract-review-*.tsx`：表单/轮询、任务历史、报告与引文定位。
- `tools/contract-review/src/agent/`：增加固定 skill、检查点恢复和原始模型交换回调。

## 后续增加功能

- 增加审查规则或依据：更新 `tools/contract-review/rules/`；调整工作步骤或判断口径时同步更新 `skills/contract-review/SKILL.md`。
- 增加新的业务流程（如款项核对、证据整理）：新增对应 skill，并补齐所需工具、服务端校验、任务数据/API 和页面；跨业务共用的能力做成工具。
- 新功能涉及保存数据、权限或结果格式时，先更新 `spec/` 中对应约定，再改代码和交接文档。Skill 负责告诉 Agent 怎么做，不能代替权限、计算和结果校验代码。

| 接口 | 行为 |
| --- | --- |
| GET /api/contract-reviews?documentId=… | 本会话任务摘要、服务端配置和确认摘要；不返回合同全文 |
| POST /api/contract-reviews | 携带 Idempotency-Key；白名单版本/条件/配置确认/外发授权，202 返回入库任务 |
| GET /api/contract-reviews/[id] | 本会话详情及有效阶段结果/最终报告 |
| POST /api/contract-reviews/[id] | action=cancel，或 action=retry 且重新确认 externalProcessingConsent=true |

写入同源检查，响应 private,no-store，参数和密钥不上前端日志。重复 key/同输入返回原任务，变化输入返回 409。
所有请求携带 X-Document-Context；成功响应回传相同上下文，浏览器在解码和显示前检查，错误沿用文档会话 code。
取消只撤销后续处理，不承诺已到模型服务的请求可撤回或不计费。

## 存储与恢复

独立 `equilens_review_schema` 版本不改文档 schema。tasks 保存输入/规则/技能/模型快照、授权、固定期限、
状态、令牌/租约、累计预算、解析快照、检查点和最终结果。artifacts 保存各尝试的原始模型请求/响应和结果。
请求产物不包含 Authorization/header；内容仍可能包含合同材料，必须作为私有资料备份。
任务外键绑定同 owner 文档和版本，原资料清理会级联清理审查及产物。

全局 runner 行租约保证串行领取，心跳 15 秒、租约 60 秒。跨进程恢复须等旧租约过期；
每个任务最多 3 次尝试、累计 600 秒。网络/超时/5xx 最多自动重新尝试一次；限流等待用户操作，不自动紧循环。
请求预算发送前事务预留，失败和不确定的请求也占用次数，不等同于精确账单。
恢复复用解析快照和有效结论，新模型重新读取用于后续提交的正文和依据；旧尝试不能写回当前结果。
阶段结果与终态在短事务中保存，解析/模型不在事务内运行。到期立即拒读/执行/外发，后台清理任务及派生物。
SQLite 备份包含上述表；恢复后按当前到期时间守卫，完整项目/法律业务恢复尚未验收。

任务复用主分支的数据库、会话仓储和删除日志就绪屏障，保持独立任务 schema。
事务内检查上下文及 read/review 权限；领取、解析和每次预算预留均重新检查。
到期取审查期限与原会话期限的较早值；只读导出窗口可读取已有结果和取消，不允许提交、重试或外发。
缺少 documentContextId 的旧任务不能恢复外发，需重新确认后提交新任务。已有文档不会自动登记期限，
存量仍须按部署说明通知、登记并完成导出窗口处理。

## 历史实现检查范围

`node node_modules/typescript/bin/tsc --noEmit --incremental false` 通过；首次发现配置 mode 推断问题，修正后通过。
按用户要求，没有运行测试、构建、浏览器、数据库迁移/恢复或真实模型请求。
UI 采用官方 Blocks 目录和 Tabs 示例，沿用现有 Resizable 工作区；无专用审查 block，使用已有官方组件组合。
审查授权的原生 checkbox 为语义表单控件，无额外定制视觉样式。没有新增组件依赖。
整合后的实际检查以[主分支整合验证](reviews/2026-10-23-contract-review-main-integration.md)为准。
