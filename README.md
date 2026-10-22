# 衡鉴 EquiLens

[![CI](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml)

**面向工程专业分包企业的法律风险与文书协同平台。**

衡鉴围绕同一工程项目组织合同、证照和履约资料，计划贯通合同审查、材料核验、
款项分析和文书撰写，使事实、来源和人工修订能在流程之间复用。

> **项目状态：**提供文档/规范库工作台和浏览器 Word 编辑器，支持新建、导入、编辑、保存、重开及导出 DOCX。
> 文档原件和保存版本存放在当前浏览器。Agent、GaussDB、OBS、MaaS、OCR 及四个业务模块尚未接入，当前不执行法律业务分析。

## 工作方式

产品首版聚焦房建机电安装专业分包，代表专业分包人，优先完成
“合同审查 → 款项核对 → 证据整理 → 催款函”。文书限定专业分包合同、补充协议和催款函三套模板。
工作台以文档和规范库组织内容，文档打开后进入编辑器与右侧 Agent 会话。
业务来源定位、人工复核和正式业务成果导出按产品契约另行实现。

应用采用 **Next.js App Router + TypeScript**，一个 Node.js 应用承担页面、接口和后台任务。
业务数据库选用 **GaussDB 集中式**，原件及导出文件使用 **OBS 私有桶**，模型分析与证照识别分别接入
**MaaS** 和 **OCR**。云服务配置与能力以实际账号验证为准。

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

IndexedDB 按浏览器及站点 origin 隔离，端口或域名变化会看到不同列表；清理站点数据会删除这些文件，
隐私模式、存储权限和配额可能限制保存。请自行下载需要保留的文件，本步没有云端同步或备份。

来源和边界见 [工作台界面规格](spec/02-workbench-ui.md)、[Word 编辑规格](spec/03-word-editing.md)
及[验证记录](docs/reviews/2026-10-22-word-editing-validation.md)，
第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
SuperDoc 1.47.2 使用 AGPLv3，项目根许可尚未选择；对外提供编辑器或发布包含它的镜像前须完成许可路径与对应源码提供安排。

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
src/lib/documents/     DOCX 校验、浏览器存储与行为测试
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
镜像标签、仓库权限、Compose 和 ECS 部署方式见 [部署指南](docs/deployment.md)。

## 规格

[规格索引](spec/README.md)是当前架构、业务行为和验收要求的入口。
`spec/` 保存已接受的契约，`docs/` 保存使用说明与历史资料，未决方案及任务通过 GitHub Issues 管理。

项目用于华为 ICT 大赛创新赛，按实际开工日起十二天 Demo、随后一个月完善的两阶段范围交付。
业务验收尚未开始，设计目标不作为已完成功能或质量指标。
