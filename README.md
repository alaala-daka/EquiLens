# 衡鉴 EquiLens

[![CI](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alaala-daka/EquiLens/actions/workflows/ci.yml)

**面向工程专业分包企业的法律风险与文书协同平台。**

衡鉴围绕同一工程项目组织合同、证照和履约资料，计划贯通合同审查、材料核验、
款项分析和文书撰写，使事实、来源和人工修订能在流程之间复用。

> **项目状态：**已初始化 Next.js 全栈应用，提供建设中首页、健康接口、pnpm 工具链和
> Docker 镜像流水线。GaussDB、OBS、MaaS、OCR 及四个业务模块尚未接入，当前不能处理业务材料。

## 工作方式

产品首版聚焦房建机电安装专业分包，代表专业分包人，优先完成
“合同审查 → 款项核对 → 证据整理 → 催款函”。文书限定专业分包合同、补充协议和催款函三套模板。
正式工作台采用原文与结果并排审阅的布局，保留来源定位、人工修改、版本和导出。

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
| 生产构建 | `pnpm build` |
| 检查运行中的应用 | `pnpm smoke` |
| 本地容器 | `docker compose up --build -d` |

```text
src/app/               页面、布局与 HTTP 入口
public/                公共静态资源
scripts/               应用冒烟检查
spec/                  已接受的产品与技术契约
docs/                  操作指南与历史资料
.github/workflows/     检查与镜像发布
```

服务端模块随实际业务建立，不预建多服务结构。开发边界见 [DEVELOPMENT.md](DEVELOPMENT.md)，
贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 镜像

GitHub Actions 在 PR 中构建并验证镜像，在主分支和版本标签检查通过后发布到
`ghcr.io/alaala-daka/equilens`。当前配置构建 Linux AMD64 镜像，使用非 root 用户运行。
镜像标签、仓库权限、Compose 和 ECS 部署方式见 [部署指南](docs/deployment.md)。

## 规格

[规格索引](spec/README.md)是当前架构、业务行为和验收要求的入口。
`spec/` 保存已接受的契约，`docs/` 保存使用说明与历史资料，未决方案及任务通过 GitHub Issues 管理。

项目用于华为 ICT 大赛创新赛，按实际开工日起十二天 Demo、随后一个月完善的两阶段范围交付。
业务验收尚未开始，设计目标不作为已完成功能或质量指标。
