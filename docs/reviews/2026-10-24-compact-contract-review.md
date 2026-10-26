# 合同审查精简输出验证

范围：Demo 匿名合同审查的生成表达、网页及 CLI Markdown 报告；不包含人工修订、账号授权或成果 DOCX 导出。
契约：[产品 §4.2](../../spec/01-product.md#42-合同风险审查)、[工作台匿名审查](../../spec/02-workbench-ui.md#匿名合同审查联调)。

## 改动

- 按六类归组，每类显示总数和最严重的一项「优先关注」，其余独立问题可展开；没有合并原始规则结论。
- 问题/建议预览分别最多 80/120 字，省略号明确提示；完整文字、引文、依据、影响和复核状态保留在详情。
- 生成端共用精简表达要求，不默认起草整段替换条款或填入建议天数、费率、金额、机构名称；篇幅为生成目标，未截断保存结果。
- 待核实（含折叠问题附带条件）、解析不完整、未覆盖、未完成及执行错误继续可见。旧任务不重跑；JSON 不变。
- 完整已读范围内，拦截「删除明确编号的整条约定，紧接要求保留该条唯一诉讼/仲裁方式」。
  局部阅读、其他同方式条款、混合条款和无法确定的替代方案不推断为矛盾；仍需人工核对法律适用及其他语义问题。

## 官方 UI 来源

已读取 [Blocks](https://ui.shadcn.com/blocks) 的 dashboard-01 源码；侧栏、图表及统计卡不适用审查结果。
使用官方 [Collapsible 示例](https://ui.shadcn.com/docs/components/radix/collapsible)及其
[示例源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/examples/collapsible-demo.tsx)，
复用仓库已有 Radix Collapsible、Button、Badge 和 Alert Dialog，无新增依赖或产品自定义 CSS。
适配保留业务文本换行、面板宽度与已有原文对话框。

## 本地验证

Windows / Node.js 24.16.0 / pnpm 11.6.0，使用合成输入及模型桩，真实模型调用 0 次。

- `pnpm check`：ESLint、路由类型和 TypeScript 通过。
- `pnpm test`：197 项，196 通过，1 项原有 Linux 文件/目录 fsync 检查在 Windows 跳过。
  新增 10 项行为检查，覆盖分组守恒、长文保留、Unicode、无风险/无效回答区分、建议矛盾正反例、
  固定编排失败保护、Agent 拒绝后待核实以及局部阅读反例。工程检查不计业务准确率或 AC 业务验收通过。
- `pnpm build`：生产 standalone 构建通过；没有发布镜像。
- 浏览器：无头 Chrome，隔离页面加载实际 `ContractReviewReport` 组件和应用样式，注入合成记录。
  19 项默认 6 条优先预览，展开后仍为 19 项；Enter/Space 展开、固定快照引文及高亮、
  历史长文展开、隐藏条目的待核实条件、390px 无横向溢出、失败/未覆盖/未完成可见与正常无风险区分通过。
  无页面脚本错误；这是组件交互验证，没有向真实任务提交材料。
- 浏览器首次检查因按钮可访问名称包含空格导致定位超时；读取实际可访问树后修正测试定位，再次通过。
- `git diff --check`：通过。

截图：[桌面](assets/compact-contract-review/desktop.png)、[窄屏](assets/compact-contract-review/mobile.png)。
浏览器脚本及运行结果在忽略目录 `.superpowers/merge-integration/browser/check-compact-report.mjs`、
`.superpowers/compact-report/browser-result.json`。

未执行：真实模型对新表达要求的遵守度评测、法律业务评测、完整任务端到端回放、Linux 容器与 GaussDB 真机验证。
不能据合成测试推断建议准确率；局部矛盾检查不能证明全部建议一致或合法。
