# 部署

## 本地镜像

需要可用的 Docker Engine，当前镜像目标平台为 `linux/amd64`。

```bash
docker compose up --build -d
pnpm smoke
docker compose logs app
docker compose down
```

应用监听容器的 `3000` 端口，Compose 只发布到宿主机 `127.0.0.1:3000`。
`GET /healthz` 仅表示应用能响应请求，不检查云服务或业务状态。
镜像以非 root 用户运行，数据库和云服务凭据不参与构建。
Compose 将命名卷 `equilens-data` 挂到 `/data`，SQLite 位于 `/data/equilens.sqlite`；保留该卷才能在重建后恢复文件。
不要使用 `docker compose down --volumes` 删除仍需保留的数据。
构建使用 BuildKit 的 pnpm store 缓存，限制并发并将下载超时设为十分钟；仍使用锁定依赖和完整性校验。

## GitHub Actions 与 GHCR

[CI 工作流](../.github/workflows/ci.yml)在 PR、主分支、`v*.*.*` 标签和手动触发时运行。
它安装锁定依赖，执行 lint、类型检查、文档行为测试及生产构建，再构建 Linux AMD64 镜像，启动容器检查
健康接口、首页、CSS、公共资源和非 root 身份。PR 不登录或发布镜像。

完成 [Word 编辑规格 §2.1](../spec/03-word-editing.md#21-许可与-api-基线)的许可与对应源码提供安排后，
由仓库管理者设置 Actions 仓库变量 `WORD_EDITOR_DISTRIBUTION_APPROVED=true`。
未设置该变量时，CI 仍执行全部检查与容器验证，跳过 GHCR 登录和发布。
启用发布后，主分支和版本标签只有在上述检查通过后才发布同一个已验证镜像，目标为
`ghcr.io/alaala-daka/equilens`。工作流自动将仓库名转为小写，fork 使用自己的命名空间。
使用自动提供的 `GITHUB_TOKEN`，不需要手工配置发布用 PAT，但仓库策略必须允许该工作流写入 Packages。

| 触发方式 | 发布标签 |
| --- | --- |
| 推送 `main` 或在 `main` 手动触发 | `main`、`latest`、`sha-<完整提交号>` |
| 推送 `v1.2.3` | `1.2.3`、`1.2`、`sha-<完整提交号>` |

版本标签不移动 `latest`；该标签跟踪主分支。正式部署应固定完整提交标签或镜像摘要。
PR 与非主分支手动运行只验证镜像。此配置文件不表示流水线已在 GitHub 运行或镜像已经发布。

首次发布后在 GitHub Packages 确认包的访问范围和仓库关联。包为私有时，部署端需自行配置
具有 `read:packages` 权限的拉取凭据；不要把凭据提交到 Compose 文件。

## ECS

将 Compose 文件放到目标主机，设置 `EQUILENS_IMAGE` 为实际发布的标签或摘要后执行：

```bash
docker compose pull
docker compose up -d --no-build
```

HTTPS 反向代理转发至回环端口，云安全组不公开数据库端口。
当前版本提供 Word 编辑和服务端文件保存，通过浏览器会话隔离，没有账号登录和项目成员权限；不能用于法律业务分析。
SQLite 模式保持一个实例并挂载持久卷；GaussDB 的连接变量见 [.env.example](../.env.example)。
项目按 AGPL-3.0-only 开源，保留[第三方许可](../THIRD_PARTY_NOTICES.md)，镜像的 `SOURCE_COMMIT` 指向对应源码。
GaussDB、OBS、MaaS、OCR 的区域、连接、权限、费用和完整项目恢复需在业务实现时验证，
相关环境变量随实际接入补充，不提供当前应用尚不读取的配置示例。

## Zeabur

使用 [zeabur-template.yaml](../zeabur-template.yaml) 在已有服务器的新项目中部署一个服务。
模板包含 HTTP 端口 `3000`、SQLite 持久卷 `/data`、精确 origin 与非 root 启动配置。
它使用 CI 验证并公开发布的镜像，不在远端重复安装依赖，不额外创建数据库服务。

```bash
pnpm dlx zeabur template deploy -f zeabur-template.yaml --project-id <project-id> --var PUBLIC_DOMAIN=equilens -i=false
```

导入前将模板 `source.image` 设为已验证的完整提交标签或摘要；Zeabur 不在该字段展开模板变量。
`APP_ORIGIN` 必须等于公开入口 `https://equilens.zeabur.app`，不带末尾斜线；反向代理内部 HTTP 不改变此配置。
`DATABASE_PROVIDER=sqlite`，`SQLITE_PATH=/data/equilens/equilens.sqlite`。只运行一个副本，以 UID 1000 运行。
启动时设置 `umask 077`，应用创建自己的数据子目录，实测目录 `700`、数据库文件 `600`；不修改挂载根目录属主。
后续升级固定新的完整提交镜像标签并重部署，保留现有卷；不要重复部署模板创建第二个服务。
域名、HTTPS、API 权限、下载和重启恢复须实测，模板导入成功不等于这些检查通过。
当前线上使用 `39a97b10ae33f23022fe805cdac5b64786cf8671` 镜像，部署与重启验证见[数据库验证记录](reviews/2026-10-22-database-validation.md)。

## SQLite 备份

```bash
docker compose exec app node scripts/backup-sqlite.mjs /data/backups/equilens-<timestamp>.sqlite
```

备份脚本使用 Node.js SQLite online backup API，目标必须为新文件，不覆盖已有备份。
将生成文件下载并存放到容器和宿主服务器以外；同一持久卷内的备份不具有异地恢复能力。
恢复时停止应用，保留现库及其 WAL/SHM 文件，将一致性备份放到新的数据库路径，设置 `SQLITE_PATH` 后启动并验证下载。
会话 cookie 是文件访问凭据，数据库恢复不能恢复已丢失的浏览器 cookie。
