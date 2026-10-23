# 合同审查 Agent 升级计划

目标：在现有 tools/contract-review 内增加 AI SDK Agent、按需加载的合同审查 skill、受限工具和可追溯阅读记录。
保留旧 reviewContract/reviewText；新增 reviewWithAgent 和后端 reviewTextWithAgent。此次不接网页或数据库任务。

1. 先更新 spec/00-overview.md、spec/01-product.md：明确有界单 Agent、引文范围、预算及调用方职责。
2. 增加 skills/contract-review/SKILL.md 和技能元数据，继续引用现有 rules/，不复制法律资料。
3. 增加 src/agent/：固定输入快照、加载 skill、分页解析结果、查读段落、读取依据、提交与强制校验。
4. 接入 AI SDK 和兼容模型适配；在实际发送前预留调用预算，保留进度钩子，错误脱敏。
5. 接通 CLI --agent、服务端入口和 standalone 资源复制，补充调用示例与交接文档。

按用户本次要求，不运行测试、构建、模型能力验证或真实模型请求，也不新增测试套件。
依赖安装只用于让新增代码具备实际依赖与锁文件。已有测试仅在行为变更处同步调整合成模型回答，不扩写测试套件。
所有未验证能力在文档中如实标注。
不自动提交、合并、推送，不改动已有本地工作以外的分支。

## 实现记录

上述五项已写入代码。依赖安装成功，package.json 与 pnpm-lock.yaml 已更新。
保留旧固定入口，新增 Agent 后端/快照入口和 CLI --agent。
局部输入仍按全文接受结论、outline-only 可 success 的旧行为已修正；同步调整两处旧合成模型回答，未运行测试。
按用户要求，未运行测试、类型检查、构建、CLI、模型工具验证或真实模型调用。
此次只完成 tools 模块及接入点，网页、数据库任务、执行器、项目授权仍待后续实现。
