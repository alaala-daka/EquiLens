# README 素材说明

- `equilens-poster.png`：2026-10-31 由 OpenAI ImageGen 生成的产品宣传海报，表达定位与目标流程，不是应用截图或验收证据。
- `contract-review.png`、`payment-reconciliation.png`：复制自 `.superpowers/roadshow/demo/browser/r7-model/` 的同名本地实机留存。
- `evidence-report.png`：复制自 `.superpowers/roadshow/demo/browser/r8/evidence-report.png`。
- `collection-letter.png`：复制自 `.superpowers/roadshow/demo/browser/r8/letter-panel.png`。

截图均使用本地合成项目与材料，原样复制，未通过 AI 重绘，不含真实客户合同。显示的金额、账号、项目和时间为演示内容。第七轮材料与款项截图展示配置和录入界面，不单凭该画面证明模型调用成功；第八轮证据及催款函由确定性逻辑生成。

这些图片展示已有功能界面，不代表本次重跑验收，也不证明端到端业务质量、领域规则签核或真实云平台已通过。来源与边界结合 `docs/reviews/2026-10-30-round-seven-integration.md` 和 `docs/reviews/2026-10-30-round-eight-integration.md` 阅读。

本次文档重写曾尝试启动本地服务并重新截图：默认 Turbopack 因 Windows 目录联接权限失败，webpack 启动成功，但 Edge 无头进程启动退出，因此最终复用并人工检查上述已有截图。未调用模型或 OCR，未重跑完整工程／业务测试。
`node scripts/smoke.mjs http://127.0.0.1:3210` 已尝试，但本次执行环境拒绝回环连接（EACCES），因此不记录为冒烟通过。`git diff --check` 通过，README 的 29 处本地文件引用均存在。
