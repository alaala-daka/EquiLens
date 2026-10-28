# 默认适应宽度与线上旧版本核对

日期：2026-10-26。阶段：Demo 编辑器体验修正。
本地基线：`050cd3b` 加本次未提交修改；生产 BUILD_ID：`4FjOptduzSLUZLfT8cyGi`。

## 线上核对

用户反馈 https://equilens.zeabur.app/ 仍有大面积右侧灰色画布。
只读访问公开 `/source`，实际重定向为
`https://github.com/alaala-daka/EquiLens/tree/39a97b10ae33f23022fe805cdac5b64786cf8671`。
该提交的 WordCanvas 仅配置 `zoom: { mode: "fit-width" }`，不含后续居中与缩放开关。
根目录 zeabur-template.yaml 仍固定同一旧提交镜像，故本地修复并未自动进入线上。
没有访问用户文档、创建线上数据或修改线上服务；未将浏览器刷新当作部署。

## 默认行为修正

用户希望直接消除宽屏大块留白。上一轮默认 100% 仍会产生大面积页外画布，
已将所属规范 §4.1 改为打开/重开默认适应宽度，然后调整引擎初始模式与开关初始状态。
继续使用原有 10%—200% 限制、64 CSS px 总预留、手动比例退出适配、局部居中及保存锁定。
未改 DOCX 的纸张尺寸、页边距、正文或导出算法。达到 200% 上限或用户主动选择较小手动比例时，
仍允许存在页外画布，不以改变 Word 页面或清除背景颜色掩盖空间。
README 与部署说明同步更新，模板未改成尚未发布或验证的镜像引用。

本次沿用上一轮已核对的 shadcn/ui 官方 Button 与 Resizable 结构，没有新增控件或自定义样式。
来源及最小局部样式适配原因见 [上一轮记录](2026-10-26-word-canvas-layout.md)。

## 本地生产验证

Windows、Node.js 24.14.1、SuperDoc 1.47.2、系统 Edge 隔离无头浏览器。
独立合成 SQLite：`.superpowers/previews/canvas-default-fit/equilens.sqlite`，测试期限两天。
未调用模型；模型配置错误提示按真实本地状态保留，不计为模型验证。

- `pnpm check`：通过。
- `pnpm test`：199 项，198 通过、1 跳过、0 失败。
- `pnpm build`：生产 standalone 构建通过。
- `pnpm smoke http://127.0.0.1:18081`：健康、页面、样式、公开资产通过。
- `git diff --check`：通过。
- 新建默认适配，无需点击：1920×1080、编辑器约 70%，自动 161%，左右灰色画布
  32.70 / 32.71 CSS px；纸宽 1277.89，画布宽 1343，无横向溢出，保存仍禁用。
- 1440×900 自动 119%、1024×768 自动 82%、390×844 自动 41%，均居中且外壳不溢出。
- 3200×1200 自动缩放遵守 200% 上限；鼠标拖动和分隔柄键盘操作重新适配，实例不重建。
- 手动 100% 仍居中；窄屏纸张可在画布内横向滚动，左端可达；手动比例跨视口保持。
- 关闭适配保留当前比例；原生菜单选择 125% 后改变视口仍保持 125%。
- 中文多行、金额 12345.67、备注及 F6 切换正常；当前版本仍未复现截图中的异常蓝线。
- 保存、导出、重开：导出与保存版本逐字节一致，解包保留合成中文和金额；
  重开保留正文和备注，默认重新开启适应宽度。
- 无浏览器 pageerror。导出 SHA-256：
  `704fcfffad67de4949cd3eca53dbca3d0dfb1c41fcdc51d7b9b2595c6e3c351a`。

原始本机脚本及数值位于忽略目录 `.superpowers/previews/canvas-default-fit-qa.py`
和 `canvas-default-fit-results.json`。脚本沿用上一轮，仅修改默认及重开预期并分开保存截图。
旧的“默认 100%”截图及验证记录保留为历史，不改写为本轮结果。

## 截图与剩余工作

- [新建默认适应宽度](assets/word-canvas-default-fit/default-fit.png)
- [手动 100%](assets/word-canvas-default-fit/desktop-100.png)
- [中文编辑和备注](assets/word-canvas-default-fit/edited-fit.png)
- [窄屏](assets/word-canvas-default-fit/mobile-fit.png)

尚未提交、推送、发布镜像或部署 Zeabur。线上需更新至通过 CI 并已发布的修复提交镜像，
保留原有数据卷和配置；操作及 `/source` 复核步骤见 [部署说明](../deployment.md#zeabur)。
本地结果不代替线上验收、原生浏览器 200% 缩放、人工 Word、真实 IME、Linux 容器或 GaussDB 验证。
