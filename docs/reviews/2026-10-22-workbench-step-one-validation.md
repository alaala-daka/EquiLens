# 工作台步骤一验证记录

实际验证日期：2026-10-22—23，Asia/Shanghai；汇总日期：2026-10-23。
文件名沿用已批准计划的日期。本记录属于 Demo 基础能力验证，不是 Demo 业务交付验收。

步骤一及配套匿名期限功能已实现，本地工程检查、SQLite 逻辑测试、生产接口冒烟及部分浏览器检查通过。
步骤一完整 UI-01—UI-06 与共用界面检查尚未全部通过；DB-08 发布验收也未全部通过。
实际 200% 缩放、部分浏览器网络失败路径、Linux 持久性、容器及 GaussDB 真机仍有缺口。
匿名会话隔离不代表项目/角色授权，未记为 AC-01 通过；没有法律业务准确率或业务 AC 通过结论。

## 范围与证据归属

契约由[规格索引](../../spec/README.md)指向：
[工作台 §3、§6—7](../../spec/02-workbench-ui.md)、
[数据库 DB-08](../../spec/04-database-deployment.md)、
[Word WD 验收](../../spec/03-word-editing.md)。本记录不另立业务契约。
操作配置沿用 [README](../../README.md)、[开发约定](../../DEVELOPMENT.md)
及[部署说明](../deployment.md#匿名资料维护与恢复)。

本次实现覆盖列表三列/移动端元数据、仅标题检索、空/加载/失败状态、取消与迟到响应保护，
服务端匿名固定期限及确认、到期拒绝、存量只读导出、新会话、清理与维护工具。
未增加项目入口、删除、历史浏览、规范管理、Word 工具栏重做或 Agent 发送。
OBS、MaaS、OCR 与四个法律业务模块仍未接入。业务项目独立副本、完整项目恢复不在本次已验证实现内。

证据由协调者执行并记录，文档汇总者没有重新运行工程或浏览器测试。
本地原始记录保存在忽略目录 `.superpowers/sdd/`，不作为公开运行资料或提交内容：

- `2026-10-22-workbench-step-one/final-controller-evidence.md`：最终安装、工程、生产接口与进程重启结果。
- 同目录 `browser-results.json`、`browser-final-extra.json`、`task-5-browser-report.md`：浏览器原始观察及排除项。
- 同目录任务 1—4 报告及配套 `2026-10-22-anonymous-retention-step-one/task-S1-report.md` 至 `task-S6-report.md`：实现/聚焦测试证据。
- 配套 `task-S6-review.md`：独立评审结论为 scoped implementation Approved；未将平台验收记为通过。
- 同目录 `final-fix-report.md`：最终 P1 日志目录持久化修复及协调者补测结果；不替代 Linux 发布验收。

私有重启 checkpoint 含 cookie/context，未复制到本文、截图或公共目录；合成 DOCX、数据库和下载原件保留在忽略目录。
下文保存可供审查的结果摘要，不声称忽略目录会随克隆分发。

## 源码与环境

分支 `codex/workbench-step-one`，基线提交 `9529b8ffc1fe6fcdb641de90a666124f5284607b`，
验证对象为其上的未提交工作树，不是该提交本身。既有规格和计划编辑保留；本次没有提交、推送、发布镜像或部署。
环境为 Windows、Node.js 24.14.1、pnpm 11.6.0、Next.js 16.4.2、SuperDoc 1.47.2。
浏览器使用隔离 Edge/CDP（端口 19231），通过既有原生 Node/CDP 工具操作实际页面；未安装新的浏览器组件库。

浏览器原始轮次使用 S4 生产构建及专用 `data/workbench-step-one-final-ui.sqlite`；
后续真实编辑、导出、错误与资源访问补测使用 S5 修复后的生产构建，同一专用 UI 数据库。
S6 最终构建另用临时合成库执行生产 API 冒烟和重启检查。
这些不是同一服务实例/同一次构建上的全部浏览器检查；以下五个 UI/客户端文件 SHA-256
在 S4 浏览器记录与 S5/S6 交付源之间一致，用于限定复用证据的范围，不能替代全量重跑。

| 文件 | SHA-256 |
| --- | --- |
| `src/components/workbench.tsx` | `de804c1688764e9b8e53493df8a5ecfead91751001c83f2bec7ae5fed271bb7c` |
| `src/components/document-session-dialog.tsx` | `32dc2e6011efeb431f7f338866195596fcfd2c7fbb71eda958c9a220a76930a8` |
| `src/components/document-editor.tsx` | `b0ae0499a972f12f537c3ec085b092d95ac97ef441e60e5c9e3f420f44dc8f15` |
| `src/components/document-list.tsx` | `f7b3b7629c763c62834f169a86f2b795c01566129de72b98cb0ea69b2638eafb` |
| `src/lib/documents/client.ts` | `4bcb4f592b8a5cf6d8ab65e7d5814366f9e9417432dc7d00200142511b9c713c` |

## 实际命令与结果

首次锁定安装完成后才进行共享依赖上的工程检查。下表为协调者记录的最终执行结果，
不是 GitHub CI 结果；未改 registry 或依赖锁文件。早期沙箱 tsx `uv_os_get_passwd ENOMEM`
及构建目录访问失败属于环境启动失败，不计为业务测试红灯；获准后在同一环境完成检查。

| 实际命令 | 最终结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出 0，锁文件无变化 |
| `pnpm check` | 退出 0，ESLint、路由类型及 TypeScript 通过 |
| `pnpm test` | 最终 P1 修复后退出 0；77 项，76 pass、1 skipped、0 fail |
| `pnpm build` | 退出 0，含 DOCX/维护 CLI 打包及 standalone 准备 |
| `pnpm smoke http://127.0.0.1:18081` | 退出 0，health、页面、CSS、公共资产通过 |
| `node scripts/smoke-database.mjs http://127.0.0.1:18081 .superpowers/sdd/2026-10-22-anonymous-retention-step-one/final-smoke-checkpoint.json` | 退出 0，独立 A/B 会话、确认、保存、冲突、幂等、严格 404 归属、Origin、无效文件检查通过 |
| 上一命令加 `--verify`，同库实际进程重启后执行 | 退出 0，上下文、固定到期时刻、当前版本摘要与原件引用保持一致 |
| `node .next/standalone/scripts/generated/anonymous-retention.mjs --help` | 退出 0；另确认 standalone 可解析 GaussDB 驱动，不代表连接真机 |
| `node .superpowers/sdd/2026-10-22-anonymous-retention-step-one/task-S5-cli-smoke.cjs` | PASS；专用临时库 inspect、只读预检、非法批次拒绝、显式合成登记及幂等/冲突验证 |
| `git diff --check` | 退出 0；仅既有 CRLF 规范化提示 |

测试输出中的 Node SQLite experimental warning 和故意注入的安全故障日志不是额外失败项。
唯一跳过项为 `DB-08: Linux file journal persists, reopens and reuses a single durable intent`，
因 Windows 平台跳过；不能计作 Linux 通过。77 项工程测试不是独立法律业务案例或准确率分母。

最终整分支评审发现日志目录递归创建后未同步其逐级父目录，可能在断电时丢失整个日志目录项。
P1 修复将每次实际意图写入/读取的目录同步扩展至文件系统根；目录及合法意图已存在的重试仍重复屏障。
失败保持禁止删除/重放，空日志初始化沿用原有行为。正式目录打开及文件同步仍使用真实文件系统。
新增两项合成故障测试仅注入目录句柄，验证父目录同步失败及重试不执行物理 DELETE，
已有意图在目录同步失败后不能绕过屏障，成功后复用同一意图并只删除一次。

协调者先执行新增聚焦测试得到 2 fail，再冻结生产修复后执行：清理聚焦文件 12 pass、1 Linux skip、0 fail；
`pnpm check` 退出 0；`pnpm test` 为上述 76 pass、1 skip；隔离 `pnpm build` 退出 0。
最终构建使用 TEMP 下 `final-fix-build20261023` 专用 SQLite/日志路径，协调者确认均未创建。
此前 74 pass、1 skip 属于修复前工程结果；浏览器、生产冒烟和实际进程重启仍为前述历史构建证据，
最终 P1 修复没有重跑这些交互或真实 Linux 同步，不能据此推导新的平台验收结论。

构建隔离：`SQLITE_PATH` 指向 `%TEMP%/equilens-final-build-20261023.sqlite`，
日志目录指向 `%TEMP%/equilens-final-build-20261023-journal`，未设 `ANONYMOUS_DATA_RETENTION_DAYS`；
构建后两路径均未创建。没有触碰默认 `data/equilens.sqlite`。

生产启动命令为 `pnpm start`；各实例均设置独立 SQLite/日志路径、`HOSTNAME=127.0.0.1`、
相应 `PORT` 和 `APP_ORIGIN`，没有终止用户已有服务：

| 实例 | 专用环境与实际观察 |
| --- | --- |
| 缺期限配置，18082 | `%TEMP%/equilens-final-missing-config-20261023.sqlite` 及同名 `-journal` 目录；未设资料期限。health 200，session new/canCreate=false，新建 503/RETENTION_UNCONFIGURED；随后停止 |
| 最终生产冒烟，18081 | `%TEMP%/equilens-final-smoke-20261023.sqlite` 及同名 `-journal` 目录；首次合成期限 2 天。冒烟和数据库冒烟通过 |
| 同库进程重启，18081 | 停止上一自有进程，再以合成期限 3 天启动；checkpoint verify 通过，既有期限不随配置变化续期 |

2/3 天仅为合成夹具值，没有选定生产保留策略。HTTP 重启检查验证当前 payload 摘要及原件版本引用；
历史原件字节不可变由仓储测试验证，不将 HTTP 引用检查写成历史字节下载验证。

浏览器实际执行的辅助命令（前缀均为 `node .superpowers/sdd/2026-10-22-workbench-step-one/`）：
`browser-acceptance.cjs`、`browser-more.cjs`、`browser-legacy.cjs`、`browser-restart.cjs`、
`browser-inspect2.cjs`，以及 `browser-final-extra.cjs inspect`、`edit`（两次）、`finish`、`extra`、`corrected`、`resources`。
这些本地工具不是产品运行依赖。

## UI-01—UI-06 实际观察

合成输入包括两个标题均为“安装合同 Alpha”但 ID 不同的 DOCX、“补充协议”、重复 22 次的 `LongTitle`，
查询 ` alpha `、`ALPHA`、`不存在`，及伪装为 DOCX 的无效文件。不同时间、同一时刻的 ID 排序和北京时间跨日
由确定性测试补证；原始浏览器列表显示到分钟相同，不声称仅凭截图验证了时刻排序。

| 验收 | 已执行证据 | 限定与缺口 |
| --- | --- | --- |
| UI-01 | 新 cookie 默认文档且无记录；切换并等待后规范库仅“暂无规范”，键盘 Enter 切换成功 | 原始 `UI01 standards` 是未等待切换的过早采样，采用后续 `standards settled` |
| UI-02 | 三列、移动端元数据、两个同名 ID 分别进入编辑器；完整长标题可聚焦，焦点 outline 为 3px；三个视口无外壳横向溢出 | 稳定排序、同瞬时时区等价和北京时间跨日由 `list-view.test.ts` 验证，非浏览器时间夹具全覆盖 |
| UI-03 | ` alpha ` 与 `ALPHA` 命中两条同名记录，返回保留 ALPHA；无匹配先等待“未找到文档”，再记录“暂无文档”不存在；清空恢复列表 | 原始 `UI03 no-match=false` 指“暂无文档”不存在，是预期结果；中文片段、仅标题排除 prompt 由确定性测试补证 |
| UI-04 | 首次列表请求失败显示错误/重试而非“暂无文档”；刷新失败保留 4 行；解封重试恢复；session GET 阻断同样显示错误且重试恢复 | 原始网络错误文本为 Failed to fetch；并发响应顺序由 store 测试补证 |
| UI-05 | 保留日期来自服务端；取消确认 0 次文档 POST 并恢复新建焦点；导入取消焦点亦有控制器覆盖记录；真实新建/导入/打开、坏 DOCX 错误、到期与新会话、只读迁移下载已观察 | 连点/提交后取消/迟到不打开/已保存可重查由 operations 测试覆盖；校验中取消、create/restart 网络失败未完成浏览器验证，不记为完整 UI-05 通过 |
| UI-06 | 列表 1440×900、1024×768、390×844；root scrollWidth 分别 1440/1024/390；键盘页签、长标题聚焦及取消焦点恢复；编辑器宽/窄屏已观察，390 时 root scrollWidth=390 | 实际浏览器 200% 缩放未执行；720×450 CSS 视口不能替代。未完成覆盖全部操作的纯键盘遍历，不记完整通过 |

到期/迁移状态在专用合成 UI 库预置会话期限/导出窗口后读取；没有修改系统时间。
观察到 legacy_export 无编辑器，仅“下载 Word”，下载摘要与保存样本一致；窗口结束后无文档行且新建禁用。
确认重开后为空列表、查询为空、可创建新文档。完整 SQL/通知登记命令未进入原始浏览器摘要，
不将该轮 UI 预置视为真实运维通知或 CLI 登记流程验收；CLI 合成登记另有上述独立冒烟。
恰好到期/窗口结束、配置变化、过期后读写/复制/下载守卫及上下文竞争由可注入时钟测试覆盖。

原始重开后旧 ID 请求曾得到 503，属于生产构建集成故障，不能作为正确隔离通过证据。
S5 修复跨 instrumentation/route bundle 的错误构造器身份后，实际重建补测为：旧会话 ID 404、
随机缺失 ID 404、当前自有 ID 200；最终 S6 数据库冒烟再次严格要求真实跨会话读/写/复制来源 404。
原始 503 保留为历史故障，已由修复后结果替代，没有将 400/409/503 当作归属隔离通过。

## Word 与 Agent 回归

实际 Word 画布输入标题和正文、Agent 输入后保存，返回列表重开，内容与输入保持一致；
实际点击导出下载 DOCX，其 SHA-256
`55b86a28f2ced94ca7252960aff2c97a6bd66c77e8b2bb01e6046c39a408450a`
与已保存 revision `743a6d61-7844-482d-b7be-26c1b5b4d093` 相同。
第二文档 Agent 输入为空，第一文档保留原输入；两者发送均禁用。未调用模型生成。
实际坏 DOCX 导入显示“文件不是有效的 Word DOCX 文档。”，保留原列表且未挂载编辑器。

浏览器工具第一次 edit 因 Agent 选择器错误失败；第二次因标题 Ctrl+A 未替换、精确标题查找失败。
随后 finish 按实际保存标题完成重开与导出验证。重复标题/正文反映工具重试输入，
不计为应用自动重复，也不声称 Ctrl+A 替换已通过。
原始 `Agent isolation new document={}` 和首次坏 DOCX 记录处于确认对话框未结束状态，
不计通过；只采用后续 confirmed document B / corrected actual UI 记录。

本轮没有 Microsoft Word 桌面人工打开核对，没有重新完成中文格式/简单表格/分页/大文档完整矩阵，
也没有完整外网请求审计。因此仅作为已有 WD 的部分回归，不宣称全部 WD-01—WD-12 通过；
此前边界仍见 [Word 验证记录](2026-10-22-word-editing-validation.md)。

## DB-08 与平台恢复边界

SQLite 合成测试覆盖固定期限/确认变化、到期守卫、迁移只读及结束边界、全批预检/幂等登记、
清理事务回滚重试、原件/版本/prompt 清理、超过 100 owner 批次、显式空行窗口、
损坏日志拒绝、生命周期非重叠与启动失败、构建不初始化数据。
一致性备份使用 Node SQLite backup；恢复旧合成备份后重放最新注入日志两次，验证不复活旧资料，
独立 owner 的版本元数据/字节保持不变。此独立 owner 夹具不是已实现业务项目授权的证明。

Windows 逻辑测试使用注入日志；实际 Windows 生产过期清理触及文件/目录同步屏障时报告清理未完成，
仍拒绝过期访问，未弱化同步要求。不能据此称已物理清理或满足全部 24 小时删除 SLA。
CLI 真实文件日志重放、断电持久性、离线删除时效及完整项目恢复未完成发布验证。

| 未执行项 | 原因/后续验证边界 |
| --- | --- |
| Linux 文件及父目录 fsync、真实日志恢复重放 | 当前为 Windows；Linux-only 测试已明确跳过 |
| Docker 非 root、卷可写、容器重启/恢复、容器内 CLI | 未找到 Docker 引擎/命令；CI 配置已更新但本次没有 GitHub CI 或容器运行结果 |
| GaussDB DB-07 及 DB-08 真机 | 未连接实际版本/模式；SQLite、驱动解析不替代其 TLS/事务/模式验证 |
| Zeabur DB-06/线上 HTTPS 与本版保存下载 | 本轮没有部署或线上验收；现有域名/模板不证明部署了本工作树 |
| 业务项目/OBS 全项目备份恢复与删除重放 | 业务能力尚未接入，未记为已实现或通过 |
| 浏览器实际 200% 缩放、create/restart 网络失败、全操作纯键盘 | 仍待专门浏览器检查；单元取消/竞争证据不替代真实交互 |
| Microsoft Word 人工往返及完整性能矩阵 | 本轮未执行 |

## 官方来源与必要适配

任务 1/4 实现报告记录已读取 [官方 Blocks](https://ui.shadcn.com/blocks) 及
[dashboard-01 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/blocks/dashboard-01/page.tsx)。
其侧栏、图表、统计卡不符合已接受的两个顶层页签，因此采用官方组件组合，保留既有 Nova 中性色预设和系统字体。

- [Table](https://ui.shadcn.com/docs/components/radix/table) 与
  [table-demo 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/table-demo.tsx)：保留表格结构；窄屏隐藏独立元数据列并移至完整换行标题下。`table-fixed`、`min-w-0`、`whitespace-normal`、`break-words` 用于避免长标题撑破外壳并让键盘可读完整内容。
- [Input](https://ui.shadcn.com/docs/components/radix/input)、[Button](https://ui.shadcn.com/docs/components/radix/button)、[Empty](https://ui.shadcn.com/docs/components/radix/empty) 与
  [empty-demo 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/empty-demo.tsx)：沿用组件结构和变体，替换资源/操作内容。
- [AlertDialog](https://ui.shadcn.com/docs/components/radix/alert-dialog)、
  [demo 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/alert-dialog-demo.tsx) 及
  [组件源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/alert-dialog.tsx)：保留 Header/Title/Description/Footer/Cancel/Action。期限确认由可取消异步操作控制，显式恢复到原操作按钮焦点；重开确认使用 Trigger，失败时保持对话框供重试。

以上为实施时来源记录，本次文档汇总未重新抓取网站。没有新增组件库、任意颜色/宽度、动画或远程字体。

## 截图

以下均为隔离合成数据；截图辅助核对布局，交互结论来自前述实际操作。
`retention-dialog.png` 为裁切不完整的原始捕获，排除于视觉验收，不在此引用。
`list-720.png` 不作为缩放证据。

| 场景 | 截图 |
| --- | --- |
| 列表 1440×900 | [查看](assets/workbench-step-one/list-1440.png) |
| 列表 1024×768 | [查看](assets/workbench-step-one/list-1024.png) |
| 列表 390×844 | [查看](assets/workbench-step-one/list-390.png) |
| 存量只读导出 | [查看](assets/workbench-step-one/legacy-export.png) |
| 到期 | [查看](assets/workbench-step-one/expired.png) |
| 编辑器宽屏 | [查看](assets/workbench-step-one/editor-wide.png) |
| 编辑器 390 窄屏 | [查看](assets/workbench-step-one/editor-narrow.png) |
