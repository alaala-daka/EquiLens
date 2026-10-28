# 第二轮共享任务板

基线 436ab99；集成分支 alaaladaka/round2/integration。状态不表示验收。

| 包 | 主写者 | 范围 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| Wave 0 | Lead/Wave0 | spec/01、02、03，contracts.ts，接口/编号 | 基线 | 已实现待审查 |
| A3c | A | tasks 执行侧、任务 HTTP、instrumentation、匿名 runner 包装 | Wave0、C1b | 未开始 |
| C1b | C | projects authorization/access、auth account(id) | Wave0 | 未开始 |
| A4a | A | results、项目成果 HTTP、results/schema.ts | Wave0 | 未开始 |
| A4b | A | exports、导出 HTTP、依赖提示 | A4a、C2c | 未开始 |
| C2c | C | storage、upload-intents、materials service/repository/schema | Wave0 | 未开始 |
| C2a | C | materials HTTP、parse_task_id、任务提交 | C2c | 未开始 |
| C2b | C | worker/subprocess/executor、构建脚本 | A3c、C2a | 未开始 |
| C3 | C | 项目 documents、documents-client、workbench | C2a、A2 | 未开始 |
| B1a/B3a | B（可选） | facts/payments 服务及 HTTP/schema | Wave0 | 未开始 |
| I1 | Lead | 迁移注册、package、集成测试、证据 | A/C 工作包 | 未开始 |

唯一共享类型写者为 Lead；迁移注册/package 为 Lead。C3 页头 document-editor.tsx 由 Lead 最小修改并互审。
当前共享目录执行不切换 A/C 分支；团队按目录所有权写入，Lead 按工作包隔离提交，避免并行 checkout。

## 冻结接口

实现签名以 round-two-plan §4.1—§4.8 为准，以下补充由 Lead 冻结：
执行器注册使用 registerTaskExecutor(kind, executor)，registry 提供 get(kind)/available()；
C2b 在显式 Node 生命周期注册 material-parse，禁止导入启动或构建时注册执行。
ProjectExecutionAccess、ResultRevisionRef、ResultValidation、ResultReview、ExportRef 已进入 contracts.ts。
C1b 提供 authorizeTaskExecution({accountId,projectId,action})，不依赖会话。
C2c 提供材料/文档/导出对象键构造与校验，A4b/C3 仅消费；无公开 URL。
C3 消费 A2 EditorAccess；服务具体输入视图由所有者在生产实现前冻结并通知消费者，不另造控制器。

## 迁移编号

0001—0006 checksum 不变。仅在 schema 存在后由 Lead 注册：

| 编号 | 所属 | 表/字段 |
| --- | --- | --- |
| 0007 | A4a/A4b | results、result_versions、result_reviews、result_dependencies、result_exports |
| 0008 | C2a/C2c | material_upload_intents；materials.parse_task_id |
| 0009 | C3 | project_documents、project_document_versions |
| 0010 | B1a | fact_versions |
| 0011 | B3a | payment_ledger_revisions |

未合入编号保留，不重排。当前未注册任何未来 schema。

## 未决与外部门槛

项目创建资格措辞冲突不擅自解决，不新增入口；真实 OBS/GaussDB/MaaS/OCR 与领域签核保持外部缺项。
A1/C0 签收、AC-01/15、UI-14/15 需实际联验；不以代码或合成夹具宣称完成。
