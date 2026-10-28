# 文档 Agent 网页接入计划

目标：在 D:/EquiLens-restore 现有启动目录中点击款项核对和证据整理，使用真实网关与持久化任务展示结果。
架构：沿用合同审查会话、任务数据库及 runner；新增有界整理/核对技能，复用精确金额工具，不扩展项目平台。

1. 先更新产品 §4.5 和工作台 §5.7，限定匿名文档增量、两角色、三次共享预算及草稿口径。
2. 新建 src/lib/document-agent/types.ts 和 src/server/document-agent/{schema,skills,validation,workflow}.ts；测试来源、单位、缺证和独立核对。
3. 扩展现有 contract-review/tasks 的提交 schema、固定输入、执行分支及结果字段；不改旧流程和数据库表结构。
4. 调整 contract-review-panel 和新增 document-agent-report：业务选择、截止日、简明结果、原文详情与 Markdown。
5. 运行领域与真实 SQLite runner/HTTP 测试、pnpm check、pnpm test 和构建；本地浏览器验证两项入口。真实模型调用只用合成输入，记录真实用量。

界面参考已读取官方 Blocks；该局部交互采用官方 Tabs 结构 https://ui.shadcn.com/docs/components/radix/tabs 和现有 Table/Button/Collapsible，不新建仪表盘布局。
不自动提交或推送；款项与证据独立工作区保留。

## 后续催款函（用户已授权连续开发）

6. 扩展 task/letterPlan 和所选上游任务快照；只读真实保存款项/证据结果，固定截止日与保留期限。
7. `src/server/document-agent/letter.ts` 实现固定模板与缺失标记；在真实稿件上独立核对，生成并校验 DOCX 后保存一次。
8. 复用现有任务 API，新增受会话守卫的 letter 下载；面板增加确认计划表单与保存草稿预览。
9. 测试合格款项引用、缺额草稿、跨会话/过期/错版本、错误金额、下载字节一致、不重复生成和原文保护。
