# 开发约定

## 技术边界

使用 Next.js App Router、TypeScript、Tailwind CSS 和 pnpm。开发与 CI 默认 Node.js 24，
pnpm 版本固定在 `package.json`；提交 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
不额外创建前后端 workspace，不增加独立服务，目录随真实实现建立。

`src/app/` 负责界面和 HTTP 入口；领域行为由服务端模块负责。
云服务适配器不向组件暴露凭据，金额计算不交给生成模型。
共享类型不能替代输入校验；文件、模型输出和文档中的指令均是不可信数据。

## 界面

产品文案使用正式、严肃、克制的表达，标签直接对应资源和操作。
不在页面添加解释段落、技术实现说明、开发过程描述、预览标记或未完成功能提示，
例如“本地预览”“本地草稿”“尚未接入”“功能建设中”。实现状态与临时限制写入开发文档。
空状态只说明缺少的资源；实际错误、权限和校验信息保持准确，不以删除说明为由虚构成功状态。

创建或修改界面前，先查看 [shadcn/ui 官方 Blocks](https://ui.shadcn.com/blocks)，
读取最接近所需界面的 Block 源码与示例，并以它为起点实现。严格沿用官方结构、布局、间距、
字体层级、组件变体与交互方式；优先替换业务文案、数据和操作，尽量保留示例自带样式。
第三方 Block 集合不作为官方示例，不能凭记忆手写一个外观相似的版本代替读取源码。

没有适用 Block 的交互，使用 [官方组件示例](https://ui.shadcn.com/docs/components)组合实现。
优先复用既有组件和标准变体，避免自己编写同类控件、任意 Tailwind 数值、自定义配色、阴影、
圆角和装饰动画。仅当具体业务、可访问性或响应式要求无法由官方模式满足时，增加最小必要样式，
并在变更说明中记录官方来源链接、偏离点及原因。保留官方键盘操作、可访问语义和响应式行为。

工作台采用文档/规范库两个页签，文档打开后为编辑器与右侧 Agent 会话；以 [界面规格](spec/02-workbench-ui.md) 为准，替代历史布局 A。
当前工作台不展示虚构的业务处理结果；Agent 发送保持禁用，不添加开发状态标签。
中文文案保持简洁，提供可访问标签、键盘操作和明确的失败、缺证及未覆盖状态。
字体优先使用本地系统字体，构建不依赖下载外部字体。

## 检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

`pnpm check` 执行 ESLint 和 Next.js 路由类型生成、TypeScript 检查。
`pnpm test` 使用 Node.js test runner、tsx 与 fake-indexeddb 验证 DOCX 拒绝条件、版本、冲突与导出失败保护。
`pnpm smoke` 检查运行中的应用，可用 `pnpm smoke http://127.0.0.1:18080` 指定入口。
冒烟检查不等于业务质量评测。业务测试随实际功能加入，使用 `*.test.ts` / `*.test.tsx`，
并映射到 [AC-01—AC-26](spec/01-product.md#12-验收标准)。

使用两空格缩进，组件使用 PascalCase，函数使用 camelCase。
不为低影响的静态内容添加镜像实现的测试；对权限、金额、来源、版本及任务恢复编写行为测试。

## Word 编辑

先阅读 [Word 编辑规格](spec/03-word-editing.md)。固定 `superdoc@1.47.2`，仅客户端动态加载；
关闭遥测与网络校对，文档处理不发往外部服务。CSP 限制连接、字体、图片和 Worker 来源。
引擎可能在导出异常后返回原件，适配器必须拦截该回退，不能仅以非空 Blob 判断成功。
最低 OOXML 工作副本可补齐缺省样式及关系部件；原件与保存版本保持原有字节。

`pnpm exec tsx scripts/create-word-fixtures.mts` 生成表格、分页和外部资源拒绝样本，
文件位于忽略的 `.superpowers/previews/word-fixtures/`。仅使用合成或明确授权文件进行验证。
项目采用 AGPL-3.0-only，保留第三方声明和许可证，并通过 `/source` 提供部署对应源码。

## 数据存储

先阅读[数据库规格](spec/04-database-deployment.md)。`DATABASE_PROVIDER` 选择 SQLite 或 GaussDB；
配置错误必须显式失败。服务端 API 按 HttpOnly 会话隔离文档，写操作检查同源 Origin。
SQLite 单实例使用持久卷，GaussDB 默认校验证书。测试覆盖 SQLite，不将其作为 GaussDB 真机验证。
上传校验使用有内存限制和超时的短生命周期子进程，不在主进程解析不可信 DOCX。
`scripts/generated/` 是构建生成的校验程序，不提交 Git、不对生成代码运行 lint。
