# 参与开发

先阅读 [README](README.md)、[开发约定](DEVELOPMENT.md) 和 [规格索引](spec/README.md)。
未决方案与任务进入 GitHub Issues；已接受的行为更新所属规格，不继续新增平行的日期版契约。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

提交变更前运行 `pnpm check`、`pnpm test`、`pnpm build` 和 `git diff --check`。
运行生产服务后使用 `pnpm smoke` 检查入口；修改镜像时还需验证容器启动和静态资源。
未执行或失败的检查应如实记录。

## 变更要求

- 保持变更聚焦，保留无关工作；不提交凭据、私有材料、构建产物和本地预览会话。
- 行为变更同步修改所属规格、实现、用户说明和相关验证。
- 使用简短的 `<type>: <summary>` 提交说明。
- PR 写清解决的问题、交付阶段、相关 AC、验证结果和剩余缺口；界面变更提供截图。
- 业务评测只使用合成或明确授权的材料，标注与发布门槛在运行独立样本前确定。

本地修改不自动发布镜像或部署。推送主分支和版本标签后，GitHub Actions 按
[部署指南](docs/deployment.md)执行检查和镜像发布。
