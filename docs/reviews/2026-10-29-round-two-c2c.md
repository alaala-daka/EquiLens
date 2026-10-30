# C2c 上传意图与存储命名空间

2026-10-29，Windows、Node 24.14.1、本地 SQLite，Demo 技术基础。合成存储与故障注入，不代表 OBS 接入或 AC-02/24/25 完整验收。

上传在 put 前登记 pending，存储成功后 stored，版本提交后 committed。恢复先查实际版本对象引用；有引用补记提交并经注入的 enqueueParse 回调补交任务，无引用才删除过期对象。回调必须重验权限并以版本作幂等键。默认过期10分钟可配置；删除失败保留尝试数。旧残留回收同样保护已引用对象。每步短事务，不跨存储 I/O 持有事务。

0008 提供独立 uploadIntentStatements，未改冻结0006数组；Lead 待 C2a补充材料 parse_task_id 后注册。新增文档与导出键构造函数，分别使用 projects/<projectId>/documents/<documentId>/versions/<versionId>/<sha256> 与 projects/<projectId>/exports/<exportId>/<sha256>。

实际验证：

- RED：新增 upload-intents.test.ts 初次执行 exit1，缺实现模块。
- 中间发现 SQLite参数重复占位导致 updated_at 空值，改为独立占位；回归发现未过期意图计入 remaining 导致断言失败，改为仅统计到期扫描项。
- 最终 `pnpm exec tsx --test src/server/materials/*.test.ts src/server/storage/*.test.ts`，exit0，25/25通过，其中新增3项：登记/存储/恢复、提交对象保护与补交幂等、过期保护/删除失败重试、键命名空间反例。
- `pnpm check`：ESLint、路由类型与 TypeScript 检查通过。
- `git diff --check -- src/server/materials src/server/storage`：exit0。

外部缺项：未验证 OBS endpoint/私有桶/AK-SK/区域签名，不新增 SDK、不发真实云请求；生产继续 createUnavailableObjectStore fail-closed。没有用合成存储冒充真实云结果。

阶段边界：本包保留已有同步解析路径，未新增主进程解析调用；C2a/C2b负责替换任务提交及受限子进程，并接入补交回调。未运行真实GaussDB、容器、完整项目恢复或runner任务联验。意图恢复由 repairResidues 入口调用，显式运行生命周期接线待集成。

独立审查修复：审查发现意图缺少来源授权与保留期限。新增0008字段 source_kind/source_reference/processing_authorized/purpose/retention_until；由已校验登记在 put 前持久化，重复意图不得改变授权/用途/期限。崩溃后 pending 意图保留这些字段；期限届满的无引用原件不等待10分钟宽限即可删除，有材料引用的对象仍由材料删除流程处理，不补交到期解析。

修复验证：新增故障边界/期限测试初次 RED（sourceKind 为 undefined），修复后材料/存储26/26通过，exit0；pnpm check exit0；定向 git diff --check exit0。仍未运行真实OBS或GaussDB。
