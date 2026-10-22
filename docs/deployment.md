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

## GitHub Actions 与 GHCR

[CI 工作流](../.github/workflows/ci.yml)在 PR、主分支、`v*.*.*` 标签和手动触发时运行。
它安装锁定依赖，执行 lint、类型检查及生产构建，再构建 Linux AMD64 镜像，启动容器检查
健康接口、首页、CSS、公共资源和非 root 身份。PR 不登录或发布镜像。

主分支和版本标签只有在上述检查通过后才发布同一个已验证镜像，目标为
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
当前版本只有建设中页面，没有登录和资料上传功能；不能用于处理真实业务材料。
GaussDB、OBS、MaaS、OCR 的区域、连接、权限、费用和完整项目恢复需在业务实现时验证，
相关环境变量随实际接入补充，不提供当前应用尚不读取的配置示例。
