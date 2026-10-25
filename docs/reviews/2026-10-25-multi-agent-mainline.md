# 多 Agent 与四场景主线验证

日期：2026-10-25。交付阶段：Demo 授权联调。契约：产品 §1.2、§4.2，架构「合同审查网页任务增量」，界面「匿名合同审查联调」。

## 最终行为与范围

新网页任务默认 multi-agent-v1，由独立场景识别 Agent、所选场景主审 Agent、独立复核 Agent 串行执行。三个模型上下文及工具菜单隔离，仍在单体应用的同一持久化任务中运行，不增加服务、数据库队列或依赖。

| 场景 | 技能 | 本次装配规则 |
| --- | --- | ---: |
| 房建机电安装专业分包 | contract-review | 19 |
| 房建装饰装修专业分包 | decoration-review | 22 |
| 房建幕墙专业分包 | curtain-wall-review | 22 |
| 房建钢结构专业分包 | steel-structure-review | 22 |

新增三场景各有独立操作技能和三条专项清单，叠加19条通用检查；新增清单及其依据是明确标记的合成联调资料，组合始终保持待核对，不继承原包发布资格。四场景均代表专业分包人，不覆盖劳务、采购、租赁、总承包或任意工程类型。

路由只接收固定解析正文和候选元数据，只能 selectScene；主审仅加载所选资源的技能和允许工具；复核只能 submitAudit。原文、技能和生成内容均不能扩大权限。
路由未匹配时停止，不产生风险结论。主审及复核意见分别保存，复核不能改写主审或替代人工复核。机器意见存在疑点或未完成复核时，不能呈现完整无风险。

每个新任务固定流程版本、四套场景资源/来源/技能摘要及复核推理设置，恢复不能改用新资源。
所有角色共用单任务最多25次实际外发、累计600秒。路由最多4次；主审为复核预留 ceil(规则数/3)+1 次。SDK 自动重试关闭，修正及失败请求也计次，超预算保留已有结果。
恢复跳过已完成角色；主审封存后，复核恢复只处理未完成规则并校验主审摘要。令牌、租约、权限和预算预留继续由原任务仓储执行。
存量没有 workflow 的任务保留旧流程，旧报告不会自动重跑。没有改账号/项目授权范围或原文档保存逻辑。

## 工程验证

- pnpm test：227项，226通过、1跳过、0失败。跳过项是既有 Windows 无法证明的 Linux 文件/目录 fsync 检查。
- pnpm check：ESLint、Next.js 路由类型和 TypeScript 通过。
- pnpm build：最终 standalone 构建通过。一次重建因本次隔离生产实例占用 .next/standalone 报 EBUSY，关闭准确核实的测试进程后重建通过，未删除工作区或停止用户开发服务。
- git diff --check：通过。
- pnpm review:contract:multi --contract tools/contract-review/fixtures/scene-decoration-contract.txt --role 专业分包人 --region 上海 --debug --dry-run：显示四场景及对应技能，未调用模型。

新增 SDK 行为测试实际运行三个独立工具循环，覆盖四场景正确资源、发布隔离、摘要篡改、跨角色累计调用号、取消/预留失败、复核失败保留主审、只恢复剩余复核、恢复输入不变、非法配置在发送前失败，以及复核疑点阻止完整无风险。
既有会话、版本、权限、租约恢复、旧令牌与文档行为回归通过。工程用例不计为产品 §12.1 法律质量验收样本。

## 真实模型和网页任务

预期先固定在 fixtures/multi-scene-cases.json。仅发送仓库合成文字或由其转换的基础 DOCX，没有发送用户业务合同。
使用已授权 .env.local 的 api.deepseek.com / deepseek-flash。网页生产实例仅监听127.0.0.1:18126；SQLite及删除日志在 .superpowers/multi-web-2026-10-25/，未使用用户开发数据库。

三个非完整流程样本先独立验证真实路由：

| 样本 | 预期与实际 | 请求 | 已知 token |
| --- | --- | ---: | ---: |
| scene-mep-contract.txt | mep-sub-2026 | 1 | 2130 |
| scene-curtain-wall-contract.txt | curtain-wall-sub-2026 | 1 | 1823 |
| scene-steel-structure-contract.txt | steel-structure-sub-2026 | 1 | 1868 |

装饰装修通过真实网页表单、同源 HTTP 接口、受限 DOCX 解析、数据库队列、三个独立上下文及报告界面跑完整链路：

- 场景：decoration-sub-2026，绑定 decoration-review；规则包含 DEC-001—003，不包含幕墙或钢结构专项规则。
- 主审22条、独立复核22/22，整体执行 success；主审有1条未采用回答，复核有2条未采用意见，均保留记录。
- 路由1次、主审12次、复核9次，共22次；已知229571 token，观察耗时191.459秒（从提交响应后开始计时，包含本机轮询等待）。
- 复核提出14条需人工核对意见、8条保留意见。14不是已确认错误数；没有领域标注，不能据此认定准确率或比单 Agent 更好。
- 封存主审内容摘要与 audit.primarySha256 一致，复核没有改写原件；全部主审结论仍待人工复核。
- 复核请求显式使用 reasoning_effort=low；路由和主审为供应商默认设置，没有静默修改模型或放大预算。

停止分支也经真实网页验证：

| 样本 | 实际状态 | 请求 | 已知 token | 后续角色 |
| --- | --- | ---: | ---: | --- |
| scene-unsupported.txt（桥梁总承包，含强制选择文档指令） | unsupported | 1 | 1800 | 无主审、无复核、0结论 |
| scene-uncertain.txt（工程类型与合同关系不明） | needs-confirmation | 2 | 4269 | 无主审、无复核、0结论 |

首次停止分支已正确得到 unsupported（1次、1861 token），但浏览器脚本把“尚未创建主审对象”误要求为显式 loaded=false，导致脚本断言失败。
修正断言后只补测两个停止分支，没有重跑已成功的完整主审/复核。该额外调用保留在总成本中。
含上述额外检查，本轮共29次真实请求、243322已知 token；这是多份独立合成任务的合计，各任务均未超过25次/600秒。次数为实际保存的模型交换及预算占用，不推算账单金额。

本机 .env.local 新增 AI_AUDIT_REASONING_EFFORT=low，仅针对已实测支持的 DeepSeek 配置，原凭据保留。其他供应商默认 default，不能假定 low 兼容。

## 界面验证与证据

实际 ContractReviewPanel / ContractReviewReport、生产 CSS 与真实 API 完成授权提交、轮询、场景和复核显示、键盘展开、快照引文高亮及390px无水平溢出；浏览器没有 pageerror。
浏览器测试外壳替代 Word 编辑器外围布局，没有重新验证 Word 编辑交互。
最终报告组件另用同一真实保存结果复测未采用意见及原文定位，并用明确构造的部分复核状态验证未复核项目可见，没有新增模型调用。

- [最终报告首屏](assets/multi-agent-mainline/final-report-top.png)
- [手机复核意见](assets/multi-agent-mainline/audit-opinions-mobile.png)
- [真实任务完整报告](assets/multi-agent-mainline/matched.png)、[手机宽度](assets/multi-agent-mainline/matched-mobile.png)
- [场景不支持](assets/multi-agent-mainline/unsupported.png)、[手机宽度](assets/multi-agent-mainline/unsupported-mobile.png)
- [场景待确认](assets/multi-agent-mainline/needs-confirmation.png)、[手机宽度](assets/multi-agent-mainline/needs-confirmation-mobile.png)

UI 先检查 [官方 Blocks](https://ui.shadcn.com/blocks)；无对应业务块，复用既有面板及 [官方 Radix Collapsible](https://ui.shadcn.com/docs/components/radix/collapsible)、[实际示例源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/examples/collapsible-demo.tsx)的 Trigger/Content 和已有 Button 变体。未新增自定义 CSS、配色或依赖。

私有证据在以下忽略目录中，未提交凭据或Cookie：

- .superpowers/multi-routing-2026-10-25/：固定预期、三份路由原始交换与结果。
- .superpowers/multi-web-2026-10-25/：完整任务及首次停止分支的输入摘要、结果、观察记录，隔离SQLite中的 model-exchange（含真实 agentRole）与全部角色检查点；trace-summary.json 汇总所有调用。
- .superpowers/multi-web-negative-2026-10-25/：修正脚本后的两份停止分支结果和浏览器摘要，数据仍在上述隔离SQLite。

## 本地使用与剩余边界

停止自己现有开发服务，再在仓库根目录运行 pnpm dev；打开保存的 DOCX，在合同审查中确认代表专业分包人、地域与外发授权，点击开始审查。新任务自动使用多 Agent，不需要选择场景或角色数量。

```sh
pnpm review:contract:multi --contract tools/contract-review/fixtures/scene-decoration-contract.txt --role 专业分包人 --region 上海 --debug
```

命令读取 .env.local 并产生真实调用费用；添加 --dry-run 只查看候选。保留单 Agent 与前期对照 CLI 供调试，新网页不再默认使用它们。

真实模型对四个场景完成了路由验证，完整真实三角色流程本轮只跑装饰装修；其他场景的主审/复核资源接线由 SDK 行为测试覆盖，不能写成四场景均完成真实模型全流程验收。
未完成独立法律标注与准确率验收，14条复核疑点仍须专业判断；新增场景不能进入正式已发布模式。
未执行 GaussDB 真机、Linux 容器恢复或完整项目恢复，本地测试不代表这些检查通过。
本次未提交、推送或部署；隔离测试服务器已关闭，用户原开发服务未被停止。
