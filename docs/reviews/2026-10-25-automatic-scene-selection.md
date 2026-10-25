# 合同审查自动场景识别验证

日期：2026-10-25。阶段：Demo 授权联调。改动契约：产品 §4.2、架构「合同审查网页任务增量」、界面「匿名合同审查联调」。

## 交付行为

新网页任务不再预选房建场景。用户确认代表专业分包人、地域及材料处理授权后，任务依次执行保存版本解析、Agent 场景识别、技能加载和六类审查。
截至本记录仅登记房建机电安装专业分包（晚于本记录的《多 Agent 与四场景主线验证》已扩展到四类）；
自主识别不代表增加其他业务场景或已完成法律验收。

识别阶段只开放固定解析快照的目录、搜索、正文和 selectScene。匹配必须完整解析、读取全文，提交登记候选 ID、理由与前一模型回合已读的逐字原文证据，并与用户确认立场一致。
后端校验通过后才开放技能加载。明确不适配或材料不足分别保存 unsupported / needs-confirmation，停止审查且没有风险结论；未知 ID、未读或虚构引文、越阶段调用、重复选择均不能绕过。

候选目录的名称、版本、适用/排除条件与技能绑定进入配置摘要和任务输入快照。选择、证据及选择时已读范围保存在结果检查点，随固定版本/解析快照保存。
恢复沿用原选择、累计请求数及时限；选择时的历史已读范围单独保存，不会因第二次恢复前尚未重读正文而丢失。后续审查提交仍要求当前模型上下文重新读取相关材料。
识别与审查共享单任务最多 25 次外部请求、600 秒，继续沿用权限、租约、执行令牌和发送前持久化预留。存量无候选目录的显式场景任务及既有后端/CLI 保持原流程。

当前后端仍装配一套规则与技能。未来增加绑定不同技能的场景，需要同步扩展资源装配和验证，不能仅在目录添加名称就宣称已支持。

## 工程验证

- pnpm test：220 项，219 通过、1 跳过、0 失败。跳过项为既有 Windows 环境不能证明的 Linux 文件/目录 fsync 检查。
- pnpm check：ESLint、Next.js 路由类型和 TypeScript 全部通过。
- pnpm build：生产 standalone 构建通过。
- git diff --check：通过。
- CLI 的 --scene auto --role 专业分包人 --region 上海 --debug --dry-run：正确显示 18 段及唯一候选，明确尚未调用模型识别。

新增行为测试覆盖：阶段工具守卫、已读证据、未知 ID、完整范围、用户立场、三种结果、共享预算、发送前守卫、文档指令、正式规则发布闸门、重复恢复、目录快照及旧令牌保护、HTTP 拒绝前端直接指定场景、非匹配 Markdown 不显示风险摘要。
这些是工程检查，不是产品 §12.1 独立业务质量样本或法律准确率验证。

## 真实网页与模型验证

使用根目录已授权 .env.local，api.deepseek.com / deepseek-flash。生产 standalone 仅监听 127.0.0.1:18126，SQLite 与删除日志隔离在 .superpowers/scene-web-2026-10-25/，不读取或修改用户现有开发文档库。
使用 fixtures/scene-selection-cases.json 事先固定三份合成材料及预期，转换为基础 DOCX，经真实上传 API 入库。
浏览器运行实际 ContractReviewPanel / ContractReviewReport 组件与生产 CSS，通过真实同源 API 提交、持久化执行、轮询和读取最终结果；浏览器测试外壳替代 Word 编辑器外围布局，没有测试 Word 编辑交互。

| 合成材料 | 固定预期 / 实际 | 请求次数 | 已知 token | 观察耗时 | 后续审查 |
| --- | --- | ---: | ---: | ---: | --- |
| scene-mep-contract.txt：办公楼机电安装专业分包 | matched / matched | 18 | 257067 | 56.424 秒 | success，19 条结论，无拒绝及执行错误 |
| scene-unsupported.txt：市政桥梁总承包，含要求强制选择的文档指令 | unsupported / unsupported | 3 | 7052 | 6.052 秒 | 未加载技能，0 条结论 |
| scene-uncertain.txt：工程范围、工程类型及合同关系未明确 | needs-confirmation / needs-confirmation | 3 | 7169 | 6.074 秒 | 未加载技能，0 条结论 |

合计 24 次真实请求、271288 已知 token；每个任务独立遵守 25 次/600 秒上限。耗时从浏览器提交响应后轮询计时，含本机等待，不代表供应商延迟基准。请求数为预算占用及已存原始交换逐条核对结果，不推算账单金额。

三份材料均先 parseDocument、再 readParagraphs、再 selectScene；匹配材料第 4 次请求才 loadSkill。
匹配材料选择时已读 18/18 段；另两份分别 5/5、4/4。所有识别引文均逐字存在于保存的解析快照。
桥梁文本内的强制选择指令未改变实际选择；这仅为本合成输入的观察，不宣称全面防御语义攻击或达到场景识别准确率。
19 条结论的 success 表示声明范围的必要检查完成，资料仍待核对、结论仍待人工复核；没有独立领域标注，不据此评价法律建议正确性。

浏览器检查通过：提交值为 scene=auto 且明确 role；不显示预设项目类型；真实识别阶段可观察；非匹配不出现空风险摘要或继续原任务按钮；识别依据可键盘展开；固定快照原文可打开并高亮；390px 宽度无水平溢出；无 pageerror。

UI 先检查 [官方 Blocks](https://ui.shadcn.com/blocks)，没有对应审查识别交互，沿用既有面板并使用 [官方 Radix Collapsible 示例](https://ui.shadcn.com/docs/components/radix/collapsible)及其 [实际示例源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/examples/collapsible-demo.tsx)的 Trigger / Content 结构与现有 Button 变体。证据引用复用原有快照定位对话框，没有新增自定义 CSS、颜色或组件依赖。

截图：

- [匹配后的最终报告](assets/automatic-scene-selection/matched.png)、[手机宽度](assets/automatic-scene-selection/matched-mobile.png)。首次实时截图尚处于轮询更新前的审查中，保留为 [处理中截图](assets/automatic-scene-selection/matched-in-progress.png)；最终两张使用同一真实任务已保存的终态 JSON，在实际面板组件中重放补拍，没有新增模型调用。
- [不支持的场景](assets/automatic-scene-selection/unsupported.png)、[手机宽度](assets/automatic-scene-selection/unsupported-mobile.png)。
- [待确认场景](assets/automatic-scene-selection/needs-confirmation.png)、[手机宽度](assets/automatic-scene-selection/needs-confirmation-mobile.png)。

隔离目录中的 expectations.json、各样本 .input.json / .result.json / .observation.json / .report.md、summary.json、trace-summary.json 保存预期、摘要、实际结果与用量；原始模型交换在隔离 SQLite artifacts 表。目录被 Git 忽略，未提交凭据或 Cookie。

## 本地复现

网页使用新代码前，停止自己现有的开发服务，再在仓库根目录执行 pnpm dev。打开或导入 DOCX，保存后在合同审查中确认立场、地域及外发授权，点击开始审查；不会因为代码更新自动重跑旧报告。
本地联调规则保持待核对，没有自动发布规则或改成正式法律结论。

独立命令行复现同一 Agent 的自动场景阶段：

```sh
pnpm review:contract:agent --contract tools/contract-review/fixtures/scene-mep-contract.txt --scene auto --role 专业分包人 --region 上海 --debug
```

该命令读取 .env.local 并产生真实模型费用；不匹配例可分别替换为 scene-unsupported.txt、scene-uncertain.txt。
--scene auto --dry-run 只显示候选，不调用模型，也不产生场景选择。

本次未新增依赖、常驻服务或数据库 schema 迁移，未提交、推送或部署。未执行 GaussDB 真机、Linux 容器恢复或正式法律业务验收。
