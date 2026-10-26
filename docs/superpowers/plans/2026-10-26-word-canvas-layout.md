# Word canvas layout implementation plan

**Goal:** 实现用户确认的“纸张居中＋可选适应宽度”，保持 DOCX 编辑及版本保存行为。

**Architecture:** 保留 SuperDoc 1.47.2 官方工具栏与分页画布，调用其公开缩放 API。
只在 WordCanvas 外壳增加标准 Button 开关及必要的画布居中样式；不改文档尺寸或生成内容。

**Tech Stack:** Next.js、React、TypeScript、shadcn/ui、SuperDoc 1.47.2。

## Constraints

- 契约归属 spec/02-workbench-ui.md §4.1；DOCX 行为继续遵循 spec/03-word-editing.md。
- 默认 100% 手动；适应宽度 10%—200%，横向预留 64 CSS px。
- 保留 70/30 分栏、键盘操作、独立滚动、生命周期和保存锁定，不新增依赖。
- 不全局移除焦点样式；蓝线仅在浏览器确认原因后修复。

## Task 1: Canvas and zoom interaction

**Files:** src/components/word-canvas.tsx、src/app/globals.css。

- [x] 检查固定依赖源码的 getZoomState、setZoomMode、zoomChange、fitWidth 配置及卸载方式。
- [x] 使用 `zoom: { initial: 100, mode: "manual", fitWidth: { min: 10, max: 200, padding: 64 } }`。
- [x] 工具栏旁组合现有 `Button`，通过 `aria-pressed` 表示适应宽度状态，监听 zoomChange 同步手动缩放。
- [x] 用当前实例及加载代次约束操作和清理；加载/失败禁用按钮，保持既有保存锁定。
- [x] 仅在 `.word-canvas` 内居中引擎 layers 和实际纸张 viewport，保留宽页溢出滚动。

## Task 2: Validation and operating notes

**Files:** README.md、docs/reviews/2026-10-26-word-canvas-layout.md、同目录截图。

- [x] Edge 使用独立合成 SQLite 数据库；保存修复前后截图。
- [x] 检查 1920、1440、1024、390 宽度及面板拖动、手动缩放、键盘开关、正文输入与焦点。
- [x] 保存重开及导出解包核对合成正文，导出与保存版本字节一致；不冒充人工 Word 验收。
- [x] 执行 pnpm check、pnpm test、pnpm build、运行入口 smoke 与 git diff --check；只记录实际结果。
- [x] README 更新缩放操作；记录官方组件来源、局部样式偏离理由和未验证项。

## Review

需求已映射至两个任务；默认、边界、失败、权限、输入输出和验收见所属规范。
用户已确认设计，按本会话内顺序实施，不创建 Issue、提交、发布或新聊天。
