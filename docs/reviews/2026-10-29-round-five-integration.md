# 第五轮集成与验收记录（C4 界面 / C6 知识发布 / C5 文书起草）

- 日期：2026-10-29，Windows 本机、Node 24.14.1、pnpm 11.6.0、SQLite（`node:sqlite`）+ 开发文件对象存储、Microsoft Edge（playwright-core 无头）。
- 分支：`alaaladaka/round5/business`（基线 `7867daf`）；提交：`04f8c40` W0 → `7c6904a` C6 → `d92244b` C5 → `529414a` C4-UI → 本文对应集成提交（含 C4-UI 混合任务修复、C5 渲染清理、迁移/注册/宿主接线）。
- 计划：[第五轮计划](../superpowers/plans/2026-10-29-round-five-plan.md)（执行前独立审查 REVISE→修订→CONFIRMED）。
- 范围：C4 项目界面、C6 受控知识/规则发布、C5 专业分包合同与补充协议确定性起草。本文只记录实际执行过的检查；未运行项单列，不宣称 AC 整项通过。

## 1. 交付包

| 包 | 内容 | 证据 |
| --- | --- | --- |
| W0（`04f8c40`） | 规格（spec/01 §4.4/§7.1/§8.2.2/§8.2.4/§9.1、spec/02 §5.1、spec/04 0011/0012）；`TaskManifest.publications` + 三态解析器（未注册 503、blocked 422 不入库）；`TASK_CATALOG_VERSION=4`；ResultService 文书 machine-only+server-owned；材料快照 `fragments`；`.env.example` 域名核对人 | `docs/reviews/2026-10-29-round-five-task-board.md`；`pnpm check` 0；定向测试通过 |
| C6（`7c6904a`） | 0011 发布仓储（草拟/待核对/已发布/已停用、不可变/替代/停用、唯一约束）、假签核守卫（启用超管操作者、`EQUILENS_DOMAIN_REVIEWERS`、核对人≠操作者、期望 sha/时间/证据）、私有 CLI（无 HTTP 写路由）、三态解析器、reviews published pin 与 published 校验 | `docs/reviews/2026-10-29-round-five-c6.md`；定向 77/77＋13 tools＋40 相邻回归 |
| C5（`d92244b`） | 代码版本化模板目录（固定“待核对”）；0012 拟约定输入不可变版本（幂等/409）；确定性渲染（缺失 `【待补充】`、不补造、只字段重渲染）；补充协议原合同 pin；server-owned partial 草稿 + `TEMPLATE_UNREVIEWED`；两个校验器/导出模板；起草工作区 | `docs/reviews/2026-10-29-round-five-c5.md`；定向 43/43 |
| C4-UI（`529414a`） | `verifications-client`、核验工作区（材料/要求候选与手工片段录入/字段/外部记录/比较任务/两组状态/校验复核导出）、片段选择、只读与切换保护 | `docs/reviews/2026-10-29-round-five-c4-ui.md`；定向 34/34（修复后 35/35） |
| I1（本文） | 迁移 0011/0012 注册与 checksum；结果校验器/导出模板/知识运行时/业务宿主接线；门禁；浏览器验收；证据 | 本文 |

跨包审查（task-16）：**APPROVE WITH FIXES**；3 个 blocker（`knowledge:maintain` 脚本、README 发布边界、C4-UI 混合任务列表使核验工作区加载失败）均已修复；非 blocker 处理见 §6。

## 2. 工程门禁（实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm check` | 0 | ESLint（`--max-warnings 0`）+ Next 路由类型 + `tsc --noEmit` 通过（集成阶段修掉脚本/未用导入等 lint） |
| `pnpm test` | 0 | **919 tests / 918 pass / 1 skip / 0 fail**（knowledge/templates/drafting 已纳入默认路径） |
| `pnpm build` | 0 | standalone 构建通过，含 drafting/verifications/知识运行时接线 |
| `pnpm start` + `pnpm smoke http://127.0.0.1:3000` | 0 | 生产 standalone 下 health/页面/样式/公共资源检查通过 |
| `git diff --check` | 0 | 无空白错误 |

均为本机 Windows/SQLite/开发文件存储结果；不是 GitHub CI、容器、Linux 或 GaussDB 结果。

## 3. 浏览器验收（实际执行，11/11 检查通过）

环境：全新临时 SQLite + `EQUILENS_SYNTHETIC_STORAGE=1`；`APP_ORIGIN=http://127.0.0.1:3000`；引导超管；本地 dev 服务；**未配置真实 OCR/模型外发**。
脚本：`scripts/verify-round-five-browser.mts`（`pnpm verify:r5 -- --database <sqlite>`）。先经 API 建立合成项目（材料上传/解析、证照字段、要求集、确定性比较成果、partial 起草草稿），再用系统 Edge 无头浏览器登录同一账号验证真实页面：

1. 项目工作区顶层页签「文档 / 业务处理 / 规范库」可见。
2. 「业务处理」内业务选择「合同审查 / 投标材料核验 / 文书起草」可见（无新增顶层页签）。
3. 投标材料核验工作区渲染并可在「核验成果」选择比较结果，展示材料检查与外部真实性两组状态（截图）。
4. 文书起草工作区渲染“待核对”模板与 partial 草稿；选择草稿后显示“不能批准为完整复核成果”的复核限制（截图）。
5. 浏览器无 pageerror；截图与结果 JSON 保存在忽略目录 `.superpowers/round5/`：`workspace-documents.png`、`business-tabs.png`、`verification-workspace.png`、`drafting-workspace.png`、`browser-acceptance.json`。

浏览器验收发现并修复 C4-UI 真实缺陷：`listTasks()` 曾对项目全部任务类型做严格解析，含 `material-parse`/`contract-review` 的项目会使核验工作区“状态获取失败”；已改为先过滤两种 C4 任务再严格解析，并加混合列表回归测试。

## 4. 本轮关键契约落实

- C6：published 版本冻结输入清单（manifest `publications`，浏览器不可提交）；解析器 `pinned|none|blocked`，未注册解析器 503，`blocked` 在入库前 422；reviews 只有结果内嵌固定 `PublishedRef` 且与 `mode:"published"` 一致才有效；停用后旧任务按固定版本执行并带“依据已停用”警告；发布/停用仅私有 CLI。
- C5：成果只能由 server-owned 生产 `ResultService` 写入（普通浏览器成果 POST 403）；模板固定“待核对” ⇒ 结果只能 `partial` 且不能批准为完整复核成果；重渲染逐字一致由校验器重算；补充协议固定本项目原合同版本；缺失字段以 `【待补充】` 标记且不补造；旧导出字节稳定。
- C4-UI：只读成员不出现写入口；错误真实显示不自动重试；任务轮询到终态停止；迟到响应隔离；要求来源片段必须来自所选快照；导出仅对 `bid-verification` 开放（要求集无模板）。
- 迁移：0011（publications/publication_versions，`UNIQUE(kind,artifact_id)`、`UNIQUE(publication_id,version)`，核对字段可空、发布转换强制非空）；0012（drafting inputs/versions，`UNIQUE(project_id,operation_id)`）；0001—0010 摘要不变。

## 5. 未运行项与外部缺项

- 真实领域核对人/签核不存在：**没有任何真实已发布规则/知识或已核对模板**；C6 测试/CLI e2e 使用合成夹具（已标注），C5 模板固定“待核对”。不得把本轮结果当作已发布法律依据或完整复核文书。
- 真实模型要求候选提取、真实 OCR（证照图片/`certificate-ocr` 提交入口）、真实 OBS/MaaS、GaussDB、公网 HTTPS、CI 运行、Docker/Linux：未运行，保持外部缺项。
- 浏览器未覆盖：只读成员/撤权页面（客户端与 handler 层有测试，浏览器只验了管理员主路径）、390×844/200% 缩放、真实 Word 排版；投标 6 例、文书 4 例封存评测与 24 例 Demo 业务集未运行。
- AC-05、AC-07、AC-11、AC-22、UI-23 整项不做通过声明；C5 正文/章节人工编辑、催款函（B 线内容）、规范库管理 UI（C6 P1）未交付。

## 6. 交叉审查处理与已知限制

- Blocker 修复：新增 `knowledge:maintain` 脚本；README 记录 `EQUILENS_DOMAIN_REVIEWERS`/私有 CLI/无真实发布边界；C4-UI 混合任务列表过滤修复并入 C4-UI 证据。
- 非 blocker：N1（blocked 解析器无独立服务级测试）与 N4（生成/重渲染未重新核对原合同材料当前活动/保留期；保存前已校验归属与类型）作为已知限制记录，列入第六轮硬化；N2 校验器证据措辞已修正（归属由服务层强制）；N3 渲染死循环已删除；N5 发布核对时间允许 ≤5 分钟时钟偏差已记录；N6 pinned runner 需要匹配的本地代码场景包（DB pack 为权威、无文件回退）已记录；调试脚本未提交；任务板/本文已更新。
- 已知限制补充：C5 以 `specialty-subcontract` 成果作原合同时，导出保留期只传播项目与材料依赖，不传播原成果依赖链（原成果仍可追溯）；OCR/知识/模板相关真实服务与领域质量仍待外部条件。

## 7. 不宣称

本轮只完成 C4 界面、C6 受控机制与 C5 确定性起草的本地实现与验收。不宣称真实 OCR/MaaS/OBS/GaussDB 可用、法律/资格结论正确、模板或规则已核对发布、浏览器全设备覆盖、容器或线上部署完成。
