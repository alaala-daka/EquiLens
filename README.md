# 衡鉴 EquiLens

[![CI](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml)

**面向工程专业分包企业的法律风险与文书协同平台。**

衡鉴围绕同一工程项目组织合同、证照和履约资料，计划贯通合同审查、材料核验、
款项分析和文书撰写，使事实、来源和人工修订能在流程之间复用。

> **项目状态：**提供文档/规范库工作台和浏览器 Word 编辑器，支持新建、导入、编辑、保存、重开及导出 DOCX。
> 文档原件和保存版本存入服务端数据库，支持 SQLite / GaussDB 配置。SQLite 已有行为测试；GaussDB 尚未连接真实实例验证。
> Agent、OBS、MaaS、OCR 及四个业务模块尚未接入网页。另有合同审查开发联调模块，内置资料待核对，尚未完成业务验收。

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

```bash
git clone https://github.com/alaala-daka/EquiLens.git
cd EquiLens
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://localhost:3000>。当前启动不需要云服务凭据，也不会发起模型或 OCR 请求。

页签、列表和对话框使用官方 shadcn/ui 组件；Word 画布和工具栏使用固定版本的 SuperDoc 1.47.2。
支持中文段落、基础格式、标题、列表和普通表格文字编辑。单个 DOCX 不超过 20 MiB；
宏、加密、外部资源、图片、页眉页脚、域、批注、修订和复杂合并表格按当前范围拒绝。
不承诺任意 Word 版式无损还原；Microsoft Word 人工核对和大文档性能验证见验证记录。

保存按钮及 `Ctrl/Cmd+S` 提交不可变 DOCX 版本；有修改时导出会先保存，再下载该版本的同一份字节。
离开编辑器前可保存、放弃或取消。多标签页保存冲突时保留当前编辑，可另存为新文档。
只有保存成功的版本能在刷新后恢复，导入原件不会被编辑覆盖。

服务端使用 HttpOnly 会话 cookie 隔离文档；其他浏览器、设备或隐私窗口有独立列表。
当前没有账号登录，清除 cookie 会失去该会话的文件访问入口，请下载需要保留的文件。
历史 IndexedDB 文档不会删除或自动上传；可从旧版导出后重新导入。持久卷不替代备份。

来源和边界见 [工作台界面规格](spec/02-workbench-ui.md)、[Word 编辑规格](spec/03-word-editing.md)
及[验证记录](docs/reviews/2026-10-22-word-editing-validation.md)，
第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
项目采用 [AGPL-3.0-only](LICENSE)，保留 SuperDoc 等第三方许可；页面“源代码”链接对应部署版本。

## 模型连接测试

在本机 `.env.local` 或服务端环境中配置 `AI_BASE_URL`、`AI_MODEL` 和 `AI_API_KEY`。
当前网关为 `https://aigw.saurlax.com/v1`，模型暂定 `glm-5.3-flash`；配置字段见 `.env.example`。
密钥不提交 Git，也不使用 `NEXT_PUBLIC_` 前缀。

```bash
pnpm ai:smoke
```

此命令只发送一次固定测试消息“请只回复：连接成功”，可能产生少量模型费用。
它显示模型回复和可用的 Token 用量；错误时返回明确原因，不输出密钥或服务端响应正文。
服务端业务可从 `@/server/ai` 导入 `askModel`。模块导入及构建不会调用模型。
此入口只验证模型连接；合同审查使用下述独立联调入口，网页及业务任务尚未接入。
实际验证与构建限制见[模型连接验证记录](docs/reviews/2026-10-22-model-gateway-validation.md)。

## 合同审查开发交接

后端固定入口为 `@/server/contract-review` 的 `reviewText`，本地入口为 `pnpm review:contract`。
先阅读[交接说明与调用示例](tools/contract-review/README.md)，其中列明前后端职责、环境配置、
返回状态、规则发布边界和待执行检查。内置规则仅供显式调试模式使用。
`pnpm review:contract:example` 使用离线合成桩，不调用模型；真实 CLI 会发送合同并产生费用。
本次未运行测试、真实模型调用或生产构建，不能据此认定已满足合同审查业务验收。

## 数据库

默认不需要云端数据库即可启动，SQLite 文件位于 `data/equilens.sqlite`。
配置示例见 [.env.example](.env.example)，开发时复制为 `.env.local`。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_PROVIDER=sqlite` | 使用 SQLite，默认值 |
| `SQLITE_PATH` | SQLite 文件路径，Zeabur 使用 `/data/equilens/equilens.sqlite` |
| `DATABASE_PROVIDER=gaussdb` | 使用 GaussDB 集中式，连接失败不回退 |
| `GAUSSDB_HOST/PORT/DATABASE/USER/PASSWORD` | GaussDB 连接配置，端口默认 `8000` |
| `GAUSSDB_CA_PATH` | 可选 CA 文件，TLS 始终校验证书 |
| `APP_ORIGIN` | 远程部署的完整 HTTPS origin，用于写请求校验 |

数据库首次访问时建立初始表，生产构建不连接数据库。切换 provider 不会自动迁移已有文档。
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
`spec/` 保存已接受的契约，`docs/` 保存使用说明与历史资料，未决方案及任务通过 GitHub Issues 管理。

项目用于华为 ICT 大赛创新赛，按实际开工日起十二天 Demo、随后一个月完善的两阶段范围交付。
业务验收尚未开始，设计目标不作为已完成功能或质量指标。
