# 编辑器纸张居中与可选适应宽度验证

日期：2026-10-26。阶段：Demo 编辑器体验修复；不代表业务 AC 验收。
工作基线：`0986dbe` 加本次未提交修改；最终生产 BUILD_ID：`VMS_CHoulwC7ZYmtGW80g`。
环境：Windows、Node.js 24.14.1、固定依赖 SuperDoc 1.47.2、系统 Edge（Playwright 隔离无头浏览器）。
本地服务绑定 127.0.0.1，生产验证端口 18081；使用 `.superpowers/previews/canvas-qa-production/`
独立 SQLite 合成库和两天测试期限，不访问用户资料，不发模型请求。

## 原因与修改

- 原实现已启用 `fit-width`，但引擎 `use-viewport-fit.js` 默认 `max: 100`。
  固定纸张在宽面板内不放大，`.superdoc` 的 flex 布局又没有居中，余量集中在右侧。
- 用户确认“纸张居中＋可选适应宽度”。先更新 `spec/02-workbench-ui.md` §4.1，
  再实现默认 100% 手动、10%—200% 自动适配及 64 CSS px 总预留。
- 调用公开 `setZoomMode`、`getZoomState`，监听 `onZoomChange`；选择原生菜单数值自动退出适配。
  关闭开关保持当前比例。视图不持久化，不修改 DOCX 页面或正文，不生成保存版本。
- 以现有加载、保存、错误和离开状态禁用开关；实例随原有生命周期清理。
  面板比例和响应式方向保持现有规范。
- 蓝线未在当前基线和最终版本的中文输入、换行中复现。当前版本真正的 ProseMirror
  输入层位于屏幕外，聚焦时 computed outline-style 为 none。保留现有焦点处理，
  未把截图中的蓝线认定为已经确认原因或由本次修复消除；截图部署版本还需核对。

## 官方来源与必要偏离

已查看 [官方 Blocks](https://ui.shadcn.com/blocks) 中 dashboard-01 的实际示例源码，
其侧栏、图表和统计卡片不适用于 Word 画布。沿用现有
[Resizable 示例](https://ui.shadcn.com/docs/components/radix/resizable)，
结合现有标准 Button 的 outline / secondary、sm 变体，保留键盘焦点并以 aria-pressed 表示状态。
核对 [官方 Button 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/button.tsx)。

不重做引擎工具栏；应用开关放在工具栏容器旁。必要自定义仅为 `.word-canvas` 内两处
`margin-inline: auto` 和标准垂直间距：居中引擎 layers 与实际 viewport，
两者分开是因为引擎外壳可比 A4 纸张宽。选择器需高于引擎窄屏 scoped margin reset，
否则手机端会恢复靠左。auto margin 在溢出时归零，宽页仍可向右滚动，不采用负向居中裁切。

## 执行结果

| 检查 | 实际结果 |
| --- | --- |
| `pnpm check` | 通过 ESLint、路由类型与 TypeScript |
| `pnpm test` | 199 项：198 通过、1 跳过、0 失败 |
| `pnpm build` | 最终生产 standalone 构建通过 |
| `pnpm smoke http://127.0.0.1:18081` | health、page、stylesheet、public asset 通过 |
| `git diff --check` | 通过 |

UI-07 / UI-13 浏览器检查使用同一个编辑器实例，DOM 标记贯穿拖动、键盘调整及响应式方向切换。
以下数值为 CSS px；百分比是编辑器缩放，不是浏览器缩放。

| 场景 | 实际结果 |
| --- | --- |
| 1920×1080，默认 70/30、100% | 纸宽 793.72，左右留白 274.80 / 274.78 |
| 同视口，键盘 Enter 开启适应宽度 | 161%，左右 32.70 / 32.71；保存仍禁用，无横向溢出 |
| 3200×1200 超宽屏 | 自动缩放停在 200%，纸张保持居中 |
| 鼠标向左拖分隔柄 250 px | 161% → 130%，纸张重新适配，实例不变 |
| 分隔柄键盘 ArrowLeft 五次 | 130% → 77%，实例不变；之后恢复约 70/30 继续检查 |
| 1440×900 适应宽度 | 119%，左右 31.09 / 31.08，无页面或正文横向溢出 |
| 1024×768 适应宽度 | 82%，左右 32.41 / 32.42，无页面或正文横向溢出 |
| 390×844 纵向布局、适应宽度 | 41%，左右 32.30 / 32.28，开关可操作，实例不变 |
| 390×844，原生菜单选择 100% | 退出适配；纸宽 793.72，画布可横向滚动，页首可达，应用外壳不溢出 |
| 手动比例与方向切换 | 100% 跨窄屏→桌面保持；退出适配保留 119%；选择 125% 后改变窗口仍为 125% |
| 中文两行及末尾空行 | 正文与金额 12345.67 正确，聚焦输入层在屏幕外且无 outline，未见蓝线 |
| F6 | 从正文进入备注并聚焦输入；备注可保存 |
| 保存、导出、重开 | 导出逐字节等于服务器返回的保存版本，解包包含合成中文与金额；重开正文/备注保留，视图恢复 100% |
| 浏览器异常 | 无 pageerror |

最终导出 SHA-256：`93639b1149493fe696cc977bcea9a29ad40c7394f9aea450da92a83d9cfbe8e7`。
合成输入：“纸张居中与适应宽度验证”“第二行：保存金额 12345.67 元。”，备注“合成布局验证备注”。
本机忽略目录保留验证脚本 `canvas-layout-qa.py` 与原始最终数值 `canvas-layout-results.json`；
以下截图提交供布局评审，不含密钥或真实业务材料。

## 截图

- [修复前（开发基线）](assets/word-canvas-layout/before.png)
- [最终生产：桌面 100%](assets/word-canvas-layout/desktop-100.png)
- [最终生产：桌面适应宽度](assets/word-canvas-layout/desktop-fit.png)
- [最终生产：1024×768](assets/word-canvas-layout/tablet-fit.png)
- [最终生产：390×844](assets/word-canvas-layout/mobile-fit.png)
- [最终生产：中文编辑及备注](assets/word-canvas-layout/edited-fit.png)

## 修复过程中的失败与边界

- 第一轮 ESLint 检出同步 effect 间接 setState；改为复用父级就绪状态和引擎缩放事件后检查通过。
- 第一轮生产浏览器复测发现手机端居中被引擎 media 样式覆盖，修正局部选择器后通过。
- 一次重构建遇到 Windows `EBUSY`，原因为本机生产验证服务占用 standalone 目录；停止该服务后重构建通过。
- 扩展键盘调整验证一度把面板缩到最小比例，脚本错误地要求宽于画布的 100% 纸张也等距居中；
  调整测试流程，在验证极限缩放后恢复默认分栏，再继续默认居中检查。实现仍保留宽页左端可达的滚动行为。
- 本机无头浏览器的默认 zoom preference 与 Ctrl+Equal 探测均未改变实际 DPR/页面比例，
  因此不计为原生浏览器 200% 缩放验证；该项仍待人工/可用有界面浏览器复核。
- 未执行人工 Microsoft Word 打开核对、Windows 原生 IME 候选窗、Linux/Docker、真实 GaussDB 或 GitHub CI。
  本次不宣称 UI-07 / UI-13 全部历史验收已完成，也不计入法律业务准确率分母。
- 未提交 Git、推送或部署；上述验证仅针对本地源码与生产构建。
