# 第四轮集成与验收记录（C4 投标材料核验服务端闭环）

- 日期：2026-10-29，Windows 10/11 本机、Node 24.14.1、pnpm 11.6.0、SQLite（`node:sqlite`）+ 开发文件对象存储。
- 分支：`alaaladaka/round4/verification`（基线 `c74a2c2`）；提交：`c9ac2bb` W0 契约冻结 → `b81aa1c` C4-OCR → `d7a9270` C4-VERIFY → `f837a9a` 集成与验收证据（本文）。未推送、未部署、未创建 Issue。
- 计划：[第四轮计划](../superpowers/plans/2026-10-29-round-four-plan.md)（执行前经独立审查并修订，审查报告在忽略目录 `.superpowers/round4/plan-review.md`）。
- 范围：C4 投标材料核验的**服务端闭环**；C4 界面、C5、C6、C7、A5 在后续轮次。本文只记录实际执行过的检查；未运行项单列，不宣称 AC 整项通过。

## 1. 交付包

| 包 | 内容 | 证据 |
| --- | --- | --- |
| W0（`c9ac2bb`） | spec/01 §4.3/§6.1/§8.2.3/§9.1/§9.3 与 spec/04 更新；共享字段词表/归一化；catalog 三拆（`bid-requirements`/`certificate-ocr`/`bid-verification`，`TASK_CATALOG_VERSION=3`）；kind 准入钩子；0010 三表（OCR 运行、插入式证照字段历史、外部核验记录）；`ResultService` server-owned 写入与 machine-only 集合；导出保留期接缝 | `docs/reviews/2026-10-29-round-four-task-board.md`；定向测试通过 |
| C4-OCR | fail-closed `OcrAdapter`（合成替身仅测试文件并有生产导入守护）；图片材料仅在 OCR 可用时受理（4 MiB/8192 px/40 MP、PNG/JPEG 真实内容）；图片不进入 material-parse、上传意图终态不被修复重投；`certificate-ocr` 执行器（恰好 1 图、每任务 ≤2 次、逐阶段撤权/保留期/预算复核、插入式字段历史、字段人工登记同版本逐字来源） | `docs/reviews/2026-10-29-round-four-c4-ocr.md`；定向 91/91（materials+C4-OCR） |
| C4-VERIFY | 要求候选（模型只提候选、失败不保存演示要求、不静默截断、部分覆盖警告）；服务端复核保存要求集（逐字片段、同版本、server-owned 唯一写入）；确定性比较（两组状态独立、低置信 OCR 待确认、asOf 语义、补遗冲突待确认、嵌套转人工）；外部核验记录追加式并绑定要求主体/证号；校验器 valid/partial/invalid 策略；`bid-verification-report-v1` 导出；HTTP 列表/详情/要求集/外部记录 | `docs/reviews/2026-10-29-round-four-c4-verify.md`；定向 106/106（verification 全部） |
| I1 | 注册接线（results registry、exports template、instrumentation、package.json 测试路径）、配置文档、集成门禁、服务端闭环验收、跨包审查修复 | 本文 |

交叉审查：独立 reviewer 结论 **APPROVE WITH FIXES**（`.superpowers/round4/cross-review.md`），2 个 blocker（提取静默截断、部分覆盖未提示）与低置信 OCR/排序确定性/主体绑定/保存上限/逐调用保留期/asOf 语义等项已修复并回归；修复后复核见 §6。

## 2. 工程门禁（实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm check` | 0 | ESLint（`--max-warnings 0`）+ Next 路由类型 + `tsc --noEmit` 通过（集成阶段修掉 3 个 ESLint 警告） |
| `pnpm test` | 0 | **797 tests / 796 pass / 1 skip / 0 fail**（skip 为 Linux 专用持久性用例；新增 verification 测试已纳入默认路径） |
| `pnpm build` | 0 | standalone 构建通过，新路由出现在构建清单（fields、verifications、requirements、external-records） |
| `pnpm start` + `pnpm smoke http://127.0.0.1:3000` | 0 | 生产 standalone 下 health/页面/样式/公共资源检查通过 |
| `git diff --check` | 0 | 无空白错误 |

说明：以上均为 Windows 本机、SQLite 与开发文件对象存储结果；不是 GitHub CI、容器、Linux 或 GaussDB 结果。

## 3. 无外部服务的服务端闭环验收（实际执行）

环境：临时全新 SQLite 数据库 + `EQUILENS_SYNTHETIC_STORAGE=1` 开发文件对象存储；`APP_ORIGIN=http://127.0.0.1:3000`；引导超级管理员 `round4admin`（合成密码）；本地 dev 服务；**未配置 OCR、未调用真实模型/OCR/OBS/GaussDB**。
脚本：`scripts/verify-bid-verification.mts`（`pnpm verify:c4 -- --database <sqlite>`），22 项检查全部通过，退出码 0。

执行路径与结果（原始输出保存在忽略目录 `%TEMP%\equilens-r4-e2e\e2e-run3.log`）：

1. 管理员登录 200；创建合成项目 201；登记项目预算 200。
2. 上传招标文件 DOCX 与证照信息 DOCX（各 202），真实解析任务成功（`success`），快照可读。
3. 证照字段人工登记 200（服务端按同材料版本原文逐字核对来源片段）。
4. 普通成果接口写要求集被拒绝 403；服务端复核保存要求集 200，校验 `valid`。
5. 提交 `bid-verification` 任务 202（确定性比较、`maxCalls=0`），任务终态 `success`、调用次数 0。
6. 成果读取：两条要求材料检查均“满足材料要求”，`coverage.pending=0`，两组状态独立；重验 `valid`；人工复核 `approved`。
7. 创建 Word 导出 201，固定所选成果版本摘要；重复下载返回同一份不可变字节（DOCX，摘要 `4981de657d063f49e68ecf12141d8417703b999242955335f789bf6a343d568f`），正文包含“确定性比较结果”与“外部真实性”。
8. `/api/projects/[id]/verifications` 列表包含两类成果；详情可读；普通成果接口写 `bid-verification` 被拒绝 403。
9. OCR 边界：未验证 OCR 时证照图片上传被拒绝（4xx，文案说明 OCR 边界）；`certificate-ocr` 提交 503 且不入库。

项目/成果标识（合成）：项目 `e8fb3e2a-1489-4dfa-8066-c37835e57b81`，要求集 `40c99e83-e178-4111-bfd6-e2e28250f50d`，核验成果 `4ccadc68-3953-4d45-8628-6e5d8b517a54`。

## 4. 本轮冻结与实现要点

- 迁移 0010：`equilens_ocr_runs`、`equilens_verification_fields`（插入式历史：`subject_key`/`revision`/`previous_id`/`superseded_at`，同一事务内保证至多一条当前值）、`equilens_verification_records`（追加式、含摘要）；未改 0001—0009 摘要。
- 要求集唯一人工写入路径：`VerificationService.saveRequirementSet` 重读材料版本/快照/片段、`quotesMatch` 逐字核对、同项目同版本与活动状态/保留期复核，组装 sources 后经 `ResultService.saveResultRevision(..., undefined, { serverOwned: true })` 保存；浏览器普通成果 POST 无法写入。
- `bid-verification` 为机器基线：确定性比较、不发起外部请求、不预留付费调用；manifest 固定要求集版本与外部记录 id+摘要；重跑产生**新 resultId**，旧成果保持可读。
- 导出保留期：`exports/access.ts` 同时按 sources 与结果依赖中的 material 版本取最早期限；核验导出元数据标注“确定性比较结果（无模型生成）”。
- OCR 生产 fail-closed：不可用时不注册 `certificate-ocr`、图片上传拒绝、准入钩子 503；合成适配器仅测试文件。

## 5. 未运行项与外部缺项

- 真实 OCR 账号/证照种类/价格与真实模型提取未验证：AC-02 的 OCR 条款、AC-04 的证照图片路径保持未通过；`bid-requirements` 生产提示词/JSON 稳定性未用真实账号验证。
- 未运行 6 个封存投标案例与领域标注：AC-04 业务正确性、AC-08/AC-14/AC-21/AC-22 整项不宣称通过（本轮只证明服务端闭环与状态/来源/导出约束）。
- 真实 GaussDB：0010 与并发/约束行为仅 SQLite 覆盖；`A5a` 同类外部缺项仍开放。
- 真实 OBS、MaaS、公网 HTTPS、GitHub CI 运行、Docker/Linux 容器：未执行；不以合成存储或本地命令替代。
- 浏览器界面：本轮无 C4 UI（第五轮），未做浏览器验收；服务端 HTTP 由脚本与 handler 测试覆盖。
- 已知限制（记录不隐藏）：冻结 0010 无 OCR 全文列，证照只有字段级证据、无可查看全文（AC-02 不宣称）；`bid-verification` 校验器不重新推导材料检查状态（机器单一写入、人工不可写，风险已记录）；外部匹配记录要求 `record.subject` 与要求义务主体一致，角色名要求（如“投标人”）需在后续界面流程填具体主体名，否则显示记录冲突；OCR `confidence:null` 视为提供方未返回置信度（仅在显式 <80 时降级待确认）；asOf 相对日期结论在报告顶部显示判定日期，逐条不重复；要求集/核验结果的人工逐条修订在后续轮次。

## 6. 交叉审查与修复

- 审查结论：APPROVE WITH FIXES；无 false-pass 或授权绕过。2 个 blocker：提取静默截断、部分解析覆盖未在候选成果提示；已改为受控失败/固定警告并加测试。
- 高价值修复：低置信 OCR（<80）证据转为待确认；排序改码元比较；匹配记录绑定要求义务主体；保存上限（≤200 要求、值 ≤200 000 字符）；每次模型调用前复核保留期；asOf 日期语义；人工字段写入前复核项目/材料授权与保留期；证照种类中英文归一；导出正文标注确定性来源。
- 修复后回归：`pnpm check` 0、`pnpm test` 796/795+1skip/0、`pnpm build` 0、`pnpm start`+smoke 通过、E2E 22/22；交叉审查复核结论见任务板。

## 7. 不宣称

本轮只完成 C4 服务端闭环与 C6/C5/C7/A5 的前置契约（迁移编号、发布预留、字段词表）。不宣称 AC-02/04/08/14/21/22 整项通过、真实 OCR/模型/OBS/GaussDB 可用、法律或资格结论正确、六例业务质量、浏览器 UI、容器或线上部署完成。
