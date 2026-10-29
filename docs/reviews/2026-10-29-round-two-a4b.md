# A4b 版本化导出验证

阶段：Demo 共用机制。范围内两轮复审已解决 Important 问题；第二次复审未发现新的 Important/Critical，复审本身未重跑测试。以下是合成 SQLite 与私有存储适配器的工程验证，不计法律质量、真实云服务或 AC 验收。

## 已实现边界

- 按明确 resultId/versionId/sha256 导出保存版本，冻结人工正文、来源、校验/复核状态、模板和渲染版本；固定 DOCX 渲染不调用模型。下载核对旧文件字节摘要，不重新生成。
- 生成要求 edit 权限；只读成员可下载；存储前后重新鉴权。HTTP 使用项目路径、同源写、4 KiB 实际输入上限、私有 no-store 和固定错误消息。
- 写对象前持久化 pending 意图、专属对象键、用途及可信保留期限；写入核验与鉴权完成后转 ready，仅 ready 对外可读。
- 恢复先确认 pending → aborted，再删除对象；成功转 cleared，失败保留重试。ready 不可回转。条件状态更新必须影响一行，零行返回 CONFLICT，不能把并发失效转换当作成功。
- pending/aborted 扫描默认 10 条、上限 100；持久化尝试次数和时间，优先扫描较少尝试项。短事务与对象 I/O 分离，逐条失败继续本批并汇总错误；成功记录退出扫描，持续失败项不阻塞未尝试项。
- 同项目、成果及保存版本的模板/渲染升级关联最新不同模板/渲染的 ready 导出为 supersedes_id；保留旧文件和历史下载。
- 依赖状态由可信服务端解析器返回 unchanged/changed/unknown，不接受浏览器声明当前版本，也不静默重算下游。
- 显式 Node 生命周期消费恢复入口，无模块导入启动工作。生产私有存储未配置时明确失败；开发合成存储仅在 development 与显式开关同时满足时启用。生产模板注册表仍为空，未知类型拒绝导出，没有测试模板或成果进入业务 UI。

契约归属：[产品 §8.2.1](../../spec/01-product.md)、[第二轮计划 §4.4/A4b](../superpowers/plans/2026-10-29-round-two-plan.md)。0007 在注册前补齐生命周期字段；后续迁移由集成统一管理。

## 实际验证

环境：Windows、Node.js 24.14.1，合成 SQLite。

| 检查 | 实际结果 |
| --- | --- |
| pnpm exec tsx --test src/server/exports/*.test.ts（fixround2） | exit 0，5 通过、0 失败 |
| pnpm check（fixround2） | exit 0，ESLint、路由类型生成、TypeScript 通过 |
| Lead 本轮全量测试 | 583 项，582 通过、1 跳过 |
| Lead 第二次生产构建 / smoke | 均 exit 0；最终 host 修复后仍需重新验证 |

测试源：[service.test.ts](../../src/server/exports/service.test.ts)、[repository.test.ts](../../src/server/exports/repository.test.ts)、[renderer.test.ts](../../src/server/exports/renderer.test.ts)、[http.test.ts](../../src/server/exports/http.test.ts)。覆盖固定人工版本、历史字节、模板替换关系、越权/撤权、摘要篡改、写入及登记失败、重启清理、清理失败重试、超过批次上限的公平性、注入零行更新、草稿标记、依赖三态和 HTTP 边界。

初版缺少写前持久化意图和模板替换关系；修复后复审发现条件更新零行误报成功，已增加检查与回归。早期并行类型错误已由后续通过的 check 覆盖，不能把早期失败或初版残留描述作为当前实现状态。

## 尚未验证

未完成真实 OBS、实际 GaussDB 并发、Linux 容器完整恢复、Microsoft Word 实际排版或法律业务质量集。合成存储重启丢失字节，不代表生产恢复能力。导出业务模板和用户入口尚未开放；本记录不宣称任一 AC 整项通过，也不代表最终 host 修复后的全量检查已完成。
