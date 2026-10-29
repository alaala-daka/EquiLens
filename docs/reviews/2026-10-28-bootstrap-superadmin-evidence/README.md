# 本地证据

对应[验证记录](../2026-10-28-bootstrap-superadmin-validation.md)。日志为实际本地输出，不是 CI。

- `final-check-output.txt`：最后一次 ESLint / 路由类型 / TypeScript 检查。
- `final-test-output.txt`：最后一次完整测试，402 总数、401 通过、1 平台跳过。
- `build-plain-unrestricted-output.txt`：未加观察器的默认生产构建成功输出。
- `build-report.md`：此前失败、诊断、限定缓存清理和最终构建命令。
- `production-smoke-output.txt`：构建产物真实 HTTP / 私有 CLI / 进程重启及生产冒烟输出。
- `production-smoke.cjs`：该次合成验证脚本；不含真实凭据、cookie、token 或私钥。
- `source-manifest.txt`：被验证的源码、规格、测试及计划 SHA-256；不包含并发编辑的其他工作计划。

复现时先按仓库说明安装锁定依赖并完成 `pnpm build`，确认本机 3187 端口空闲。
从仓库根目录将脚本复制到忽略目录后执行，日志留在该忽略目录：

```powershell
New-Item -ItemType Directory -Force .superpowers/admin-verification | Out-Null
Copy-Item docs/reviews/2026-10-28-bootstrap-superadmin-evidence/production-smoke.cjs .superpowers/admin-verification/production-smoke.cjs
node .superpowers/admin-verification/production-smoke.cjs
```

脚本只使用临时合成 SQLite 库，显式提供模型空密钥，不提交真实材料或发起模型调用。
账号密码是脚本中的合成夹具，不能用于部署。进程在检查结束后退出，临时合成库由临时目录保留策略处理。
本地 HTTP 请求手工设置合成 HTTPS Origin/cookie，不能替代公网 HTTPS 或浏览器安全 cookie 验收。
