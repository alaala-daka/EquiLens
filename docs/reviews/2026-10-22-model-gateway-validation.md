# 模型网关最小接入验证

范围依据：[架构中的模型网关契约](../../spec/00-overview.md#模型网关的最小接入)。
仅单次纯文本连接，不包含文档读取、合同审查、网页入口、账号或业务队列。

## 已执行

- 先运行新增测试，因调用模块尚未建立出现 `MODULE_NOT_FOUND`，实现后 6 项模型测试通过。
- `node scripts/build-docx-validator.mjs` 后，通过 `node --import tsx --test` 运行原有文档、数据库和新增模型测试，共 30 项通过。
- ESLint `--max-warnings 0`、Next.js 路由类型生成、TypeScript `--noEmit` 和 `git diff --check` 通过。
- 网关 `/models` 返回 200，包含 `glm-5.3-flash`。
- 实际运行 `node --import tsx scripts/check-model.mts`：模型返回“连接成功”，输入 18、输出 72、合计 90 Token。
  只发送固定合成消息“请只回复：连接成功”，未发送合同或数据库内容。

## 观察到的问题与边界

- 沙箱内网络请求失败；获准联网后首次生成请求在 30 秒超时。
  单独诊断时相同消息正常返回，随后通过实际调用模块再次验证成功；未以延长正式超时或自动重试隐藏问题。
- `next build` 在沙箱内外均报 Turbopack 错误：SuperDoc CSS 处理子进程在建立连接前退出。
  因而本次不能报告生产构建通过。此步没有修改页面、CSS、Next.js 配置或 Word 编辑引擎。
- 模型测试只验证连接、协议和错误处理，未评价模型回答的法律正确性。
- 测试不访问真实 GaussDB、线上网站或部署环境，没有发布镜像或部署。
- 凭据仅保存在 Git 忽略的本机环境文件中；文档、源码与测试不包含真实密钥。

## 再次测试

在本机环境或 `.env.local` 配置 `AI_BASE_URL`、`AI_MODEL` 和 `AI_API_KEY`，执行 `pnpm ai:smoke`。
每次显式执行只请求一次，可能产生模型费用；不要把此命令加入默认自动化测试或构建。
