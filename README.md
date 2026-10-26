# 衡鉴 EquiLens

[![CI](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml)

**面向工程专业分包企业的法律风险与文书协同平台。**

衡鉴围绕同一工程项目组织合同、证照和履约资料，计划贯通合同审查、材料核验、
款项分析和文书撰写，使事实、来源和人工修订能在流程之间复用。

> **项目状态：**提供文档/规范库工作台和浏览器 Word 编辑器，支持新建、导入、编辑、保存、重开及导出 DOCX。
> 文档原件和保存版本存入服务端数据库，支持 SQLite / GaussDB 配置。SQLite 已有行为测试；GaussDB 尚未连接真实实例验证。
> 匿名固定期限、到期拒绝访问、服务内清理及私有维护工具已实现；Linux 日志持久性与容器恢复仍待本版验证。
> 合同审查 Agent 已接入匿名 DOCX 工作区与持久化任务，仅供授权联调；内置资料均待核对，正式模式拒绝使用。
> OBS、MaaS、OCR 及其余业务模块仍待接入，账号/项目授权和法律业务验收尚未完成。

[在线使用](https://equilens.zeabur.app) · [部署说明](docs/deployment.md)

## 工作方式

产品首版聚焦房建机电安装专业分包，代表专业分包人，优先完成
“合同审查 → 款项核对 → 证据整理 → 催款函”。文书限定专业分包合同、补充协议和催款函三套模板。
工作台以文档和规范库组织内容，文档打开后进入编辑器与右侧 Agent 会话。
业务来源定位、人工复核和正式业务成果导出按产品契约另行实现。

应用采用 **Next.js App Router + TypeScript**，一个 Node.js 应用承担页面、接口和后台任务。
数据库通过环境变量选择 **SQLite** 或 **GaussDB 集中式**。SQLite 适用于单实例运行，Zeabur 部署挂载持久卷。
后续业务原件及导出文件计划使用 **OBS 私有桶**，模型分析与证照识别分别接入 **MaaS** 和 **OCR**。
云服务配置与能力以实际账号验证为准。

## 从源码运行

使用 **Node.js 24** 和 **pnpm 11.6.0**。

当前本地目录的配置、样本及逐步操作见[本地复现指南](docs/local-development.md)。

```bash
git clone https://github.com/alaala-daka/EquiLens.git
cd EquiLens
pnpm install --frozen-lockfile
# Copy .env.example to .env.local and register ANONYMOUS_DATA_RETENTION_DAYS before creating documents.
pnpm dev
```

打开 <http://localhost:3000>。当前启动不需要云服务凭据，也不会发起模型或 OCR 请求。

页签、列表和对话框使用官方 shadcn/ui 组件；Word 画布和工具栏使用固定版本的 SuperDoc 1.47.2。
支持中文段落、基础格式、标题、列表和普通表格文字编辑。单个 DOCX 不超过 20 MiB；
宏、加密、外部资源、图片、页眉页脚、域、批注、修订和复杂合并表格按当前范围拒绝。
不承诺任意 Word 版式无损还原；Microsoft Word 自动打开与渲染核对、大文档单次实测和人工验收缺口见验证记录。

保存按钮及 `Ctrl/Cmd+S` 提交不可变 DOCX 版本；有修改时导出会先保存，再下载该版本的同一份字节。
标题、正文和 Agent 待发送输入共用保存状态；没有修改时保存禁用，快捷键不新增版本。
桌面编辑器与 Agent 默认按 70/30 排列，可拖动或用分隔柄键盘调整；窄屏按相同比例上下排列，区域分别滚动。
正文中按 `F6` 转到右侧备注，按 `Shift+F6` 转到文档操作；菜单打开或组合输入期间保留原有按键处理。
备注随当前文档保存，自由会话发送保持禁用。离开编辑器前可保存并离开、放弃更改或取消，保存失败留在当前文档。
加载失败时可重新加载；未保存修改先经确认。多标签页保存冲突时保留当前编辑，可另存为新文档。
只有保存成功的版本能在刷新后恢复，导入原件不会被编辑覆盖。

服务端使用 HttpOnly 会话 cookie 隔离文档；其他浏览器、设备或隐私窗口有独立列表。
当前没有账号登录，清除 cookie 会失去该会话的文件访问入口，请下载需要保留的文件。
历史 IndexedDB 文档不会删除或自动上传；可从旧版导出后重新导入。持久卷不替代备份。

匿名资料按[数据库规格](spec/04-database-deployment.md)使用固定保留期限。负责人须先登记用途和天数；
新建、导入前确认实际到期日期，同会话后续操作及配置调整不续期。到期立即停止旧资料读写与下载；
请在到期前打开文档，使用“导出 Word”保存需要保留的版本。到期后可“开始新会话”，新列表不继承旧资料。
cookie 只提供访问凭据，清除或过期不会触发服务端删除，也不能恢复访问入口。
服务启动重放删除日志后开放资料访问，并在启动及每小时尝试清理到期资料；故障期间仍拒绝过期访问。
存量资料须先通知并登记导出窗口，窗口内仅原会话可读和导出，结束后拒绝访问。
窗口登记、私有删除日志及恢复重放见[部署说明](docs/deployment.md#匿名资料维护与恢复)。

来源和边界见 [工作台界面规格](spec/02-workbench-ui.md)、[Word 编辑规格](spec/03-word-editing.md)
及 [Word 验证记录](docs/reviews/2026-10-22-word-editing-validation.md)、
[工作台步骤一验证记录](docs/reviews/2026-10-22-workbench-step-one-validation.md)、
[编辑器步骤二验证记录](docs/reviews/2026-10-23-editor-step-two-validation.md)，
第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
项目采用 [AGPL-3.0-only](LICENSE)，保留 SuperDoc 等第三方许可；页面“源代码”链接对应部署版本。

## 合同审查联调

先配置匿名资料保留期限，再在忽略的 `.env.local` 配置 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`。
内置规则未完成领域核对，只能显式使用 `AI_REVIEW_MODE=debug` 联调；生产默认 `published` 会拒绝这些资料。
打开已保存 DOCX 后，在右侧「合同审查」确认地域、所选版本、发送目标和外发授权。
保存版本变化后需要重新确认。审查记录最多按 `AI_REVIEW_RETENTION_DAYS` 保留，原资料先到期时一并停止访问和清理。
生产须显式设置 1–365 天的审查期限及经验证的 `AI_REVIEW_MAX_PROMPT_CHARS`。
Agent 累计请求上限为 25 次，可配置 1–25；重试与恢复不重置预算。真实审查会发送合同并可能产生费用。

任务与文档共用会话上下文、删除日志就绪屏障和期限守卫；撤销、到期及只读导出窗口阻止新处理。
网页任务用法见[交接说明](docs/contract-review-web.md)，CLI 和后端入口见[模块说明](tools/contract-review/README.md)。
`pnpm ai:smoke` 仅发送一次固定合成消息验证模型连接；`pnpm review:contract:example` 使用离线合成桩。
本地整合验证见[验证记录](docs/reviews/2026-10-23-contract-review-main-integration.md)，不计为法律业务准确率验收。

编辑器打开文档时以 100% 居中显示纸张。点击工具栏旁的“适应宽度”可随面板宽度自动缩放
（10%—200%）；再次点击保持当前比例，在原生缩放菜单选择数值也会退出自动适配。
纸张宽于画布时可在正文区域横向滚动。缩放不改变正文、分页尺寸或保存版本。

## 数据库配置

本地认证基础已增加受控账号、可撤销会话和持久化登录限流，尚未接入登录页面和项目权限，不计为 AC-01 通过。
从源码运行的服务器维护入口为 `pnpm account:maintain <create|reset|disable|enable> --username <账号> --actor <运维标识>`；当前未打包此命令到 standalone 镜像。
创建/重置只从私有标准输入接收 UTF-8 密码（去除一个末尾换行），拒绝在终端明文键入，不支持密码参数；
使用受保护的输入来源，不将密码写入 shell 历史、Git 或日志。停用/重置撤销已有会话，账号创建不自动获得项目权限。
命令按当前数据库配置显式初始化业务迁移；先备份目标数据库，勿对生产试运行。仅合成 SQLite 已验证，GaussDB 另行验收。

默认不需要云端数据库即可启动，SQLite 文件位于 `data/equilens.sqlite`。
配置示例见 [.env.example](.env.example)，开发时复制为 `.env.local`。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_PROVIDER=sqlite` | 使用 SQLite，默认值 |
| `SQLITE_PATH` | SQLite 文件路径，Zeabur 使用 `/data/equilens/equilens.sqlite` |
| `ANONYMOUS_DATA_RETENTION_DAYS` | 新建、导入、复制必需，正整数天数，无默认值；负责人登记用途和期限 |
| `ANONYMOUS_DELETION_JOURNAL_DIR` | 私有持久删除日志；SQLite 默认数据库旁 retention-journal，GaussDB 必须显式配置 |
| `ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` | 可选、另行登记的空会话窗口，正整数，无默认值；未设不清理空行，显式空值或非法值使资料就绪失败 |
| `DATABASE_PROVIDER=gaussdb` | 使用 GaussDB 集中式，连接失败不回退 |
| `GAUSSDB_HOST/PORT/DATABASE/USER/PASSWORD` | GaussDB 连接配置，端口默认 `8000` |
| `GAUSSDB_CA_PATH` | 可选 CA 文件，TLS 始终校验证书 |
| `APP_ORIGIN` | 远程部署的完整 HTTPS origin，用于写请求校验 |

运行期显式初始化数据库和删除日志，生产构建不连接数据库或启动清理。切换 provider 不会自动迁移已有文档。
资料期限缺失或非法时新建返回 503；已有有效期限仍可读取、保存和下载，到期后立即拒绝。
删除日志初始化或重放失败时资料接口返回 503；健康接口仍独立可用。
存储边界与独立 GaussDB 验收见[数据库规格](spec/04-database-deployment.md)。

生产构建与启动：

```bash
pnpm build
pnpm start
```

`GET /healthz` 返回应用存活状态。它不检查数据库或外部服务，也不表示业务流程已可用。

## 开发

| 工作 | 命令 |
| --- | --- |
| 安装锁定依赖 | `pnpm install --frozen-lockfile` |
| 本地热更新 | `pnpm dev` |
| 代码与类型检查 | `pnpm check` |
| DOCX 与版本存储测试 | `pnpm test` |
| 生产构建 | `pnpm build` |
| 检查运行中的应用 | `pnpm smoke` |
| 本地容器 | `docker compose up --build -d` |

```text
src/app/               页面、布局与 HTTP 入口
src/components/        工作台、Word 适配器与官方 UI 组件
src/lib/documents/     DOCX 校验、存储客户端与历史浏览器存储
src/server/            数据库适配、文档版本与会话隔离
public/                公共静态资源
scripts/               应用冒烟检查
spec/                  已接受的产品与技术契约
docs/                  操作指南与历史资料
.github/workflows/     检查与镜像发布
```

服务端模块随实际业务建立，不预建多服务结构。开发边界见 [DEVELOPMENT.md](DEVELOPMENT.md)，
贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 镜像

GitHub Actions 构建并验证镜像；完成许可安排并启用发布开关后，在主分支和版本标签检查通过时发布到
`ghcr.io/alaala-daka/equilens`。当前配置构建 Linux AMD64 镜像，使用非 root 用户运行。
镜像标签、仓库权限、Compose、Zeabur 和 ECS 部署方式见 [部署指南](docs/deployment.md)。

## 规格

[规格索引](spec/README.md)是当前架构、业务行为和验收要求的入口。
前端开发按[工作台界面规格](spec/02-workbench-ui.md)依次完善工作台、编辑器，再接入业务交互，
从合同审查推进到款项核对、证据整理和催款函。步骤一已实现标题检索、列表状态、操作取消和会话期限交互，
并完成本地 SQLite 工程与部分浏览器验证，历史缺口见
[步骤一验证记录](docs/reviews/2026-10-22-workbench-step-one-validation.md)。步骤二已实现编辑状态、统一保存与导出、
离开保护和面板响应式；工程检查、SQLite 重启、实际浏览器多视口与原生 200% 缩放、Word 自动往返检查已执行，
完整 UI/WD 验收及平台缺口见[步骤二验证记录](docs/reviews/2026-10-23-editor-step-two-validation.md)。
当前 Word 正文的 Tab/Shift+Tab 焦点无法退出，序列化超时后状态标签误报打开失败，UI-13 尚未通过；
Windows 中文输入法候选选字、人工 Word 验收及平台恢复仍待验证。步骤三业务验收尚未完成。
`spec/` 保存已接受的契约，`docs/` 保存使用说明与历史资料，未决方案及任务通过 GitHub Issues 管理。

项目用于华为 ICT 大赛创新赛，按实际开工日起十二天 Demo、随后一个月完善的两阶段范围交付。
业务验收尚未开始，设计目标不作为已完成功能或质量指标。
