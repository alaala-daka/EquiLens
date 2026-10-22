# 数据库接入验证

依据：[数据库与单体部署](../../spec/04-database-deployment.md)。使用合成 DOCX，不上传实际合同。

## 已运行

- `pnpm check`：lint、路由类型与 TypeScript 通过。
- `pnpm test`：24 项通过，其中保留 18 项 DOCX / 历史浏览器存储测试，新增 6 项数据库配置、SQLite、HTTP 与解析隔离测试。
- `pnpm build`：生产构建通过，包含文档 API、源码入口与独立校验程序。
- Docker Node.js 24 镜像构建通过，非 root 应用使用持久卷 `/data`。
- `scripts/smoke-database.mjs`：真实 HTTP 新建、保存、重读、重复操作、旧版本冲突、跨会话访问/复制拒绝、缺失 Origin 和非法文件拒绝通过。
- 强制重建 Compose 容器后，原卷内保存版本 ID、正文摘要、字节及标题保持一致。
- `scripts/backup-sqlite.mjs` 生成一致性备份，备份以只读 SQLite 打开并读取文档记录通过。

## 许可与边界

用户于 2026-10-22 明确选择 AGPL-3.0 开源，根许可证采用 AGPL-3.0-only，保留第三方归属及许可文本。
源码、构建脚本、锁文件公开，运行镜像通过 `SOURCE_COMMIT` 和 `/source` 关联对应版本。
GitHub 仓库发布变量 `WORD_EDITOR_DISTRIBUTION_APPROVED` 已设为 `true`。

GaussDB 使用华为维护的 `gaussdb-node@0.2.2` 适配，配置测试检查默认 TLS 证书校验及缺失配置拒绝。
未提供 GaussDB 实例和凭据，未运行 DB-07 真机验收；SQLite 测试不证明 GaussDB 的版本与模式兼容。
浏览器会话隔离不替代账号和项目成员授权，清除 cookie 不提供账号恢复。
未完成异地备份恢复演练、Microsoft Word 人工验收或法律业务 AC 验收。

## Zeabur 实测

- 项目：`6ad9bfc941d0e9b6bfde90c2`，使用已有东京服务器，未购买服务器或新增独立数据库服务。
- 活跃服务：`6ad9c67d79815446417f863c`；环境：`6ad9bfc9ce88521483143e24`。
- 域名：[equilens.zeabur.app](https://equilens.zeabur.app)，HTTPS、首页、CSS、公共资源及健康接口通过。
- 镜像：`ghcr.io/alaala-daka/equilens:sha-39a97b10ae33f23022fe805cdac5b64786cf8671`。
  [CI](https://github.com/alaala-daka/EquiLens/actions/runs/39744937323) 完整通过并发布该镜像。
- 线上运行数据库 API 冒烟检查通过：新建、保存、重读、重复保存、旧版本冲突、跨会话读取/复制拒绝、缺失 Origin 与非法文件拒绝。
- 重启命令成功；日志记录旧 Pod 在 08:19:26 UTC 停止、新 Pod 在 08:19:28 UTC 启动。
  新 Pod 启动后重读原版本，ID、摘要、DOCX 字节及标题一致。
- 通过容器命令确认 UID `1000`；`/data/equilens` 权限 `700`，SQLite 文件权限 `600`。
- `/source` 返回公开仓库的完整部署提交地址，未指向浮动的主分支。
- 本地浏览器通过真实 Word 画布输入中文、保存、刷新及重开，内容一致；线上浏览器可加载文档工作台。

平台限制：`source.image` 不展开模板变量，必须写实际镜像引用。挂载根目录不能由非 root 容器执行 chown；
模板改为 `umask 077` 并使用应用自行创建的数据子目录。首个未成功启动的空服务已删除并确认暂停，无用户文档。
