# 第五轮 C4-UI 投标材料核验工作区记录

- 日期：2026-10-29，Windows 本机、Node 24、pnpm 11.6.0、SQLite（`node:sqlite`）+ 开发文件对象存储。
- 分支：`alaaladaka/round5/business`，HEAD `04f8c40`（W0 契约冻结）。本包改动**未提交**，由 Lead 审查后按路径提交。
- 范围：C4 服务端闭环（第四轮）之上的项目界面；不新增顶层页签，业务选择由 Lead 的宿主 `project-business-workspace` 提供。
- 本文只记录实际执行过的检查；浏览器验收由 Lead 执行，未在本文宣称。

## 1. 交付文件

新增：

| 文件 | 内容 |
| --- | --- |
| `src/lib/business/verifications-client.ts` | 任务提交/查询（`bid-requirements`、`bid-verification`，Idempotency-Key）、`GET /verifications` 列表/详情、服务端受控要求集保存、外部核验记录追加、材料字段读取/登记、结果 validate/review/export/download、管理员预算读取/登记；统一错误码映射、私有 no-store、只读本地拒绝、迟到响应 ABORTED、无自动重试 |
| `src/lib/business/verifications-client.test.ts` | 请求路径/请求体、错误映射、只读与管理员守卫、迟到响应、导出字节、畸形响应 |
| `src/components/business/platform/project-verification-workspace.tsx` | `ProjectVerificationWorkspace`：材料、要求候选/手工要求集、字段、比较任务与轮询、两组状态结果、外部记录、复核/导出；未保存登记、页面/项目切换隔离 |
| `src/components/business/platform/verification-state.ts` + `.test.ts` | 纯逻辑：标签/词表、材料可用性、任务显示与轮询停止、提交签名与幂等、要求集解码/校验/就绪、字段与记录表单校验、结果投影与两组状态、导出/复核门槛、片段定位 |
| `src/components/business/platform/verification-requirement-editor.tsx` | 要求集编辑（机器候选确认/更正/驳回、手工录入、片段选择、单层 AND/OR、保存前检查）、只读要求表 |
| `src/components/business/platform/verification-evidence-panels.tsx` | 证照字段读取/人工登记/更正历史（OCR 原值与人工值分列、材料原文支持/待确认）、外部核验记录追加（来源/时间/条件/结论/证明版本） |
| `src/components/business/platform/verification-result-panel.tsx` | 要求集与比较结果展示：覆盖摘要、材料检查与外部真实性两列独立、未完成项、记录/材料快照、复核意见、导出与已有导出下载 |
| `src/components/business/platform/verification-fragment-picker.tsx` | 解析快照片段选择（搜索/定位/预览），手工要求与字段来源共用 |
| `src/components/business/platform/verification-draft.ts` + `.test.ts` | 项目级浏览器本地“核验输入”草稿（提取/比较条件、字段/记录表单），保存/放弃参与 `UnsavedRegistry` |

修改：

| 文件 | 内容 |
| --- | --- |
| `src/lib/business/materials-client.ts` | 快照片段只读扩展：`snapshot(materialId, snapshotId)` 返回快照/材料/版本与按序 `fragments`（消费 W0 §4.4） |

未修改（按分工由 Lead/其他包负责）：`project-documents-workspace.tsx`、`project-business-workspace.tsx`、`spec/**`、`src/server/verification/**`、`src/server/materials/**`、`tasks/results/exports/**`、`instrumentation.ts`、`package.json`、迁移。

## 2. 行为要点（实现位置）

- 材料：仅已解析且未失败快照可用于要求来源；证照图片/已解析文档可用于字段与比较；材料表显示解析状态、覆盖与用途。
- 要求：`bid-requirements` 机器候选进入编辑器后逐条确认/更正/驳回；驳回转 `rejected` 记录并保留原文；手工要求必须从同版本快照片段录入，保存前客户端检查与提示，服务端仍逐字复核；未全部确认/性质待确认/条件不可执行时明确提示不能用于比较。
- 字段：区分 OCR 原值、人工登记、材料原文支持/待确认；更正必须填写理由；插入式历史保留；人工值需引用同版本片段逐字匹配才计材料支持（服务端再次核对）。
- 比较：提交 `bid-verification` 固定 `{materials, requirementSet:{id,versionId,sha256}, externalRecords}` 与必填判定日期；任务 5 秒轮询 `GET /api/tasks/[id]`，终态停止；不伪造进度。
- 结果：材料检查与外部真实性两列独立；仅“人工查询记录匹配”为外部通过，未核验/未查到/查询失败永远非通过；未完成项、警告、错误、记录/字段更新提示均展示；invalid 结果可读可驳回但禁止批准与导出；`bid-requirements` 无导出模板故不提供导出。
- 只读：client 在发请求前本地拒绝提交/保存/登记/复核/导出；界面隐藏写操作；查看、重验、下载已有导出保留。
- 未保存与切换：要求集编辑以服务端受控保存作为“保存并离开”，短表单写入项目级本地草稿；切换项目/页签沿用 `UnsavedRegistry`；卸载/切项目时请求中止，迟到响应被 `isCurrent` 拒绝。
- 空状态：只命名缺失资源（暂无核验材料/要求集/核验任务/核验成果/证照字段/外部核验记录/导出），不含开发说明。

## 3. 实际执行的检查

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm exec tsx --test src/lib/business/verifications-client.test.ts src/components/business/platform/verification-state.test.ts src/components/business/platform/verification-draft.test.ts` | 0 | 34 tests / 34 pass / 0 fail（原始输出 `.superpowers/round5/c4-ui-tests.log`） |
| `pnpm exec eslint <本包 12 个文件> --max-warnings 0` | 0 | 无错误/警告（`.superpowers/round5/c4-ui-eslint.log`） |
| `pnpm exec tsc --noEmit` | 0 | 全仓类型检查通过（`.superpowers/round5/c4-ui-tsc.log`） |

测试覆盖：client 请求路径/请求体/幂等键、401/403/404/409/422/429/503 与安全消息映射、访问失效通知、只读与管理员本地拒绝、迟到响应 ABORTED、单次失败不自动重试、导出响应字节校验；任务状态/轮询停止与结果引用解码；要求集解码/计数/就绪/逐条与整集校验、手工要求/驳回/表达式；字段表单（来源逐字匹配、日期/标识归一化、更正理由）；外部记录表单（要求归属、证明版本、时间归一化、结论）；两组状态投影与复核/导出门槛；片段过滤/定位/预览；本地草稿往返、损坏与存储失败降级。

## 4. Lead 浏览器验收建议路径（手工路径，不依赖模型）

1. 宿主「业务处理」→「投标材料核验」；页头“投标材料核验/刷新/前往文档”。
2. 项目材料表：对已解析招标 DOCX 点“证照字段”（或先核对用途徽标“要求来源”）；在证书材料上选择材料版本 → “选择来源片段” → 片段面板“选择该片段” → 填字段值/更正理由 → “保存字段”；检查“更正历史”。
3. “要求候选提取”区可跳过模型：点“新建手工要求集” → 选择来源材料 → “选择原文片段” → 片段面板选择 → 填义务主体/性质/材料关系；比较条件选“字段比较”填字段/运算/值 → “确认要求” → “保存要求集”。
4. “运行材料比较”：选择已确认要求集、比较材料、判定日期 → “运行比较”；“核验任务”区观察持久状态，终态后“核验成果”刷新。
5. “核验成果”点“查看”：两列状态、未完成项；对比较结果“重新校验/批准/驳回/导出 Word”，已有导出可下载。
6. 选择核验结果后“外部核验记录”：选择要求 → 查询来源/时间/条件/结论/证明版本 → “追加核验记录”；回到“运行材料比较”勾选该记录并重跑后进入新成果外部状态。
7. 只读成员：材料/任务/成果可见，提交/保存/登记/复核/导出入口不出现；字段与要求表只读。

## 5. 未运行项与边界

- 浏览器验收、截图与真实页面交互：由 Lead 执行；本包未做浏览器/React 渲染测试（仓库无组件渲染测试环境），组件生命周期仅以纯逻辑测试覆盖。
- 真实模型要求候选提取：未运行（无真实 MaaS 配置/额度）；手工路径不依赖模型。无真实 OCR：证照图片路径、`certificate-ocr` 提交入口未交付（服务端 fail-closed，未验证 OCR 时不开放），仅覆盖 OCR 字段读取与人工登记/更正。
- 未接入真实 OBS/GaussDB、未做容器/Linux/CI；未运行 6 例投标封存评测与领域标注；不宣称 AC-04/AC-14/AC-21/AC-22/UI-23 整项通过。
- 已知限制：要求集编辑器逐条确认（无批量操作）；复核人/核验人由服务端账号记录，界面不显示账号 ID；主机集成与宿主页签接线由 Lead 完成；比较重跑产生新成果，旧成果只读。
