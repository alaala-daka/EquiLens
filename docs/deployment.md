# 部署

EquiLens 是一个 Next.js 应用，镜像使用 Node.js 24，目标平台为 `linux/amd64`。
以下采用 SQLite：只运行一个实例，将 `/data` 挂载为持久卷，通过 HTTPS 对外访问。

## 配置

使用 Compose 时，在仓库根目录复制 `.env.example` 为 `.env`，填写实际配置；
使用 Zeabur 时，在服务的环境变量中填写。

| 配置 | 说明 |
| --- | --- |
| `APP_ORIGIN` | 实际 HTTPS 入口，如 `https://equilens.zeabur.app`，不带末尾斜线 |
| `DATABASE_PROVIDER` | 使用 `sqlite` |
| `SQLITE_PATH` | Compose 固定为 `/data/equilens.sqlite`；Zeabur 模板为 `/data/equilens/equilens.sqlite` |
| `ANONYMOUS_DATA_RETENTION_DAYS` | 负责人登记的资料保留天数，必填正整数，无默认值 |
| `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` | 使用模型功能时填写实际服务地址、模型和密钥 |
| `AI_REVIEW_RETENTION_DAYS` | 使用模型功能时填写审查记录保留天数，生产为 1–365 |
| `AI_REVIEW_MAX_PROMPT_CHARS` | 使用模型功能时填写已验证的模型提示容量，范围 1000–240000 字符 |

生产审查默认 `AI_REVIEW_MODE=published`，要求已发布的规则；内置未发布规则仅供显式 `debug` 联调。
密钥只放在私有运行配置中，不提交 Git 或写入镜像。其他配置见 [.env.example](../.env.example)。

## 预设超级管理员

首次部署可同时配置 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD`，没有默认账号或密码。
密码须为 12–128 个字符、UTF-8 不超过 512 字节；创建成功后移除这两项环境变量（不要留空）并重新部署。
后续启动不会覆盖密码或恢复已撤销的权限。使用 Compose 时，须在 `app.environment` 显式传入这两项，
仅填写 `.env` 不会自动注入容器。后续账号维护见[运维说明](operations.md#预设超级管理员)。

## Docker Compose：本机或 ECS

需要 Docker Engine 和 Compose。在仓库根目录执行以下任一方式。

**从源码构建：**

```bash
docker compose up --build -d
```

**使用已发布镜像：**

在 `.env` 设置 `EQUILENS_IMAGE=ghcr.io/alaala-daka/equilens:sha-<完整提交号>`，替换为实际已发布版本，然后执行：

```bash
docker compose pull
docker compose up -d --no-build
```

私有镜像需先用具有 `read:packages` 权限的凭据登录 GHCR。
仓库 CI 仅在许可及对应源码提供安排完成、设置 `WORD_EDITOR_DISTRIBUTION_APPROVED=true` 后发布镜像；
主分支使用 `main` / `latest` / `sha-<完整提交号>` 标签，版本标签使用版本号。正式部署固定完整提交标签或摘要。

Compose 将服务发布到 `127.0.0.1:3000`，配置 HTTPS 反向代理转发到该地址，`APP_ORIGIN` 填公开 HTTPS 入口。
命名卷 `equilens-data` 保存数据库和删除日志。保留该卷，不执行 `docker compose down --volumes`。

## Zeabur

1. 在 [zeabur-template.yaml](../zeabur-template.yaml) 中将 `source.image` 替换为实际已发布的目标镜像；模板固定的旧镜像不会自动更新。
2. 在已有服务器的新项目中导入模板，部署一个服务。
3. 保持单副本、HTTP 端口 `3000`、持久卷 `/data` 和 UID `1000`，填写上面的配置。
4. 绑定域名并启用 HTTPS，确认 `APP_ORIGIN` 与最终访问地址严格一致。

更新已有服务时直接更换镜像并重新部署，保留原环境变量和 `/data` 卷；不要重新导入模板创建空服务。

## 检查与更新

通过实际 HTTPS 域名检查 `/healthz`、首页、`/login` 和文档保存/重开/下载；
检查 `/source` 是否指向目标提交。`/healthz` 成功仅表示进程可响应，不代表登录或模型已就绪。

Compose 查看日志：

```bash
docker compose logs --tail=100 app
```

升级前备份数据；镜像部署更新 `.env` 中的 `EQUILENS_IMAGE` 后执行 `pull` 和 `up -d --no-build`；
源码部署更新代码后执行 `up --build -d`。只更改环境配置时执行 `docker compose up -d --force-recreate`。
备份与恢复步骤见[运维说明](operations.md)。
