# 衡鉴EquiLens-工程承包企业法律风险与文书协同平台

面向房建工程专业分包企业，围绕同一项目完成投标材料核验、合同风险审查、
合同与文书撰写，以及工程款争议分析。

当前为华为 ICT 大赛创新赛赛道一的设计阶段：开工后 12 天交付可演示 Demo，
Demo 交付后另有一个月完善。
正式应用尚未实现；已完成业务与架构讨论，并确认原文与结果并排审阅的布局 A。

## 设计文档

- [两阶段设计规格 v1.1：Demo 与完善版](docs/superpowers/specs/2026-10-19-engineering-legal-ai-platform-design.md)
- [初步规格审查报告：v1.0 历史审查](docs/reviews/2026-10-20-spec-feasibility-review.md)
- [已确认布局 A 的交互草图截图](docs/superpowers/specs/assets/engineering-legal-workbench-a.png)

设计采用 React / TypeScript、FastAPI、独立任务进程和 PostgreSQL，
在 ECS 上部署，使用 OBS、MaaS 与按需 OCR。
研发过程计划通过码道及 CodeArts 工具链保留实际记录。

Demo 保留四个业务模块和三类文书，限定机电安装专业分包、规则和固定模板的深度，
贯通合同审查、款项核对、证据整理和催款函；后续一个月完善覆盖、质量评测及体验。
项目隔离、来源与版本、金额口径、人工修订保护和真实失败状态从 Demo 阶段落实。
规格保留 AC-01—AC-18，并增加 AC-19—AC-26；各项均为待实现、待验证要求。

用户整体审阅设计后进入实施计划阶段。运行、安装和部署说明随真实实现补充，
当前不提供尚无法执行的启动命令。

本地交互草图和预览会话保存在被忽略的 `.superpowers/` 目录中，
不作为正式应用或云上交付结果。
