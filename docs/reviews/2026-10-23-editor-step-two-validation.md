# 编辑器步骤二验证记录

验证日期：2026-10-23。交付范围为[工作台规格 §4、§6—7](../../spec/02-workbench-ui.md)、
[Word 编辑规格](../../spec/03-word-editing.md)和[数据库规格](../../spec/04-database-deployment.md)。
这是十二天 Demo 准备中的编辑器基础验证，不代表 Demo 四业务、三模板或 AC 验收完成。

工程检查、应用冒烟和本地 SQLite 同库重启验证通过；独立 QA 完成实际 Edge 多视口/原生 200% 缩放、
保存/失败/离开/冲突/下载/会话失效，以及 Microsoft Word 自动打开、格式和完整正文往返检查。
修复前构建的编号列表编辑无法通过已测 Tab、真实 Shift+Tab 或 Escape 后 Tab 退出，且序列化超时标签误报打开失败；UI-13 失败。
原始所谓 Shift+Tab 使用 CDP modifier=1（Alt），已排除；更正为 Shift=8 后，空白段落可退出，编号列表仍失败，不能概括为所有正文均困住焦点。
完整 UI-07—UI-13、WD 和平台验收尚未通过，不能用控制器单元测试替代实际界面或 Word 验证。

## 验证对象与环境

| 项目 | 实际值 |
| --- | --- |
| 分支 / HEAD | `codex/editor-step-two` / `64d11f9c60cd478fe643d6020d21d73f3f073175`，含未提交工作树 |
| 环境 | Windows / PowerShell；Node.js `v24.14.1`；实际 pnpm `11.6.0` |
| 依赖 | Next.js `16.4.2`、React `19.3.0`、SuperDoc `1.47.2`，锁文件安装未升级 |
| 生产 Build ID | `UWuXZcRsVKmclTjA681O7` |
| standalone server.js SHA-256 | `0721e57dbb249032bfe319de0a7db94806ad11477b4548da66459102539b8113` |
| 被测运行源码树 SHA-256 | `5ef28c9c1801b2624dc168298bfaa29fe82a37e8f25defc085a5acc881368162`，100 文件 |
| 入口 | `http://127.0.0.1:18083`，本次启动前确认无监听 |

运行源码摘要覆盖 tracked/untracked 的 `src/`、`public/`、`scripts/`、包/锁文件及
Next/TypeScript/PostCSS/组件配置。每文件 SHA-256 按路径排序，以 `hash␠␠path\n` 拼接后再摘要；
文档不进入运行摘要。逐文件清单和改动路径保存在下述私有证据目录。未提交源文件也纳入摘要，不能仅用 HEAD 识别被测对象。

本轮实现变更：`document-editor.tsx`、`word-canvas.tsx`、`workbench.tsx`、`ui/resizable.tsx`、
新增 `editor-leave-dialog.tsx`、`editor-session.ts`/测试、`engine-lifecycle.ts`/测试，
及 `serialize.ts`/测试；Task 6 仅更新 README、DEVELOPMENT 和本记录。
既有未跟踪 readiness/plan 文档保留。未提交、推送、发布镜像或部署。

## 原始工程证据

原始输出及退出码留在忽略目录
`.superpowers/sdd/2026-10-23-editor-step-two/task-6-evidence/`。
其中 `*.log` 为完整输出，`*.exit.txt` 为实际退出码；`tested-runtime-tree.json`、
`build-identity.json`、`changed-paths.txt` 固定被测对象。checkpoint 含 cookie/contextId，
数据库及所有合成 DOCX 不放入 public 或 Git，不在本记录输出凭据、正文或下载字节。

以下命令顺序执行，安装、测试、构建没有并行。pnpm 在已授权的 sandbox 外运行，避免已知启动挂起；
结果均为本机检查，未运行 GitHub CI。

| 命令 | 退出码 | 本次结果 / 原始文件 |
| --- | --- | --- |
| `node --version` / `pnpm --version` | 0 / 0 | `v24.14.1` / `11.6.0`；`node-version.log` / `pnpm-version.log` |
| `pnpm install --frozen-lockfile` | 0 | `Already up to date`；`install.log` |
| `pnpm check` | 0 | ESLint、Next 路由类型生成、TypeScript 通过；`check.log` |
| `pnpm test` | 0 | 121 项：120 通过、0 失败、1 跳过，0 cancelled/todo；`test.log` |
| `pnpm build` | 0 | 编译、类型检查、静态页生成和 standalone 准备成功；`build.log` |
| `git diff --check` | 0 | 命令无输出；仅保留退出码 `diffcheck.exit.txt`（未生成 log） |
| `pnpm exec tsx scripts/create-word-fixtures.mts` | 0 | 生成既有表格/分页及外链拒绝样本；`fixtures.log` |
| `pnpm smoke http://127.0.0.1:18083` | 0 | health/page/stylesheet/public asset 通过；`smoke.log` |
| `node scripts/smoke-database.mjs http://127.0.0.1:18083 <本计划私有 checkpoint>` | 0 | 同意、保存、竞争、归属、Origin、无效文件通过；`database-smoke.log` |
| 同库重启后，上条命令加 `--verify` | 0 | 固定 context/到期日、版本 ID/摘要及原件引用保持；`database-restart-verify.log` |

唯一跳过项为 `DB-08: Linux file journal persists, reopens and reuses a single durable intent`：
需要 Linux 文件/目录 fsync 证据；Windows 测试使用注入 journal。测试与生产日志有 Node SQLite
`ExperimentalWarning`，保留为运行环境提示。本次测试输出的安全错误类别
`Document storage request failed`、`Anonymous retention initialization failed`、
`Anonymous retention sweep failed` 来自故障用例，测试失败数仍为 0，不包含私有错误明细。
工程命令未出现失败，因此没有工程修复/重测轮次；后续实际 QA 的失败另列，不能覆盖原始记录。

## 生产运行与数据库重启

用忽略目录中的 `start-production.ps1` 显式设置以下值后执行 `pnpm start`。
启动前验证端口空闲，数据库首次创建于本计划证据目录，未复用开发库或用户会话。

| 变量 | 本轮夹具值 |
| --- | --- |
| `DATABASE_PROVIDER` | `sqlite` |
| `SQLITE_PATH` | 本仓库绝对路径下 `.superpowers/sdd/2026-10-23-editor-step-two/task-6-evidence/synthetic.sqlite` |
| `ANONYMOUS_DELETION_JOURNAL_DIR` | 同目录 `retention-journal` |
| `APP_ORIGIN` | `http://127.0.0.1:18083` |
| `PORT` / `HOSTNAME` | `18083` / `127.0.0.1` |
| `ANONYMOUS_DATA_RETENTION_DAYS` | `2`，仅合成测试夹具，不是生产默认或策略 |
| `ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` | 显式移除环境继承，本轮未配置空会话窗口 |

初次 launcher PID `44496`，验证命令行属于本计划后仅停止其自身进程树，同库重启。
最终 launcher PID `63328`、监听 PID `46312`；服务器留给独立 QA 继续运行，无后续计划重启。
`production-first/final.stdout.log`、`production-first/final.stderr.log`、
`production-first-stop.log` 和 listener/PID 文件保留启动与停止依据。

HTTP smoke 验证正常保存重开、同 operationId 重试返回同 revision、并发保存一个成功一个冲突、
跨会话 read/update/copy **严格 404**、缺 context 400、无 cookie 的上下文变化 409、
缺少/外部 Origin 403、无效 DOCX 422。它没有注入真实网络响应丢失；这一语义的控制器测试
验证相同序列化字节与 operationId 重试；后续独立浏览器 QA 实际模拟服务端提交后响应 503，
同 operationId 重试保持同 revision，见下文，不将此注入等同所有断网条件。
HTTP 原件检查为 originalRevision 引用及当前保存字节；原件不可变摘要另由仓储测试覆盖。
独立 QA 后续只读查库比对四个历史版本与实际下载文件，见下表；未验收历史下载路由，
也未在编辑前单独抓取原件数据库快照，不将引用检查冒充原件字节核对。

## 输入与验收状态

既有脚本样本为忽略目录 `.superpowers/previews/word-fixtures/contract-table.docx`、
`external-resource.docx`，包含中文、标题、加粗、表格、显式分页、斜体/下划线及外链拒绝输入。
保留独立 QA 已准备的 `.superpowers/sdd/2026-10-23-editor-step-two/fixtures/`，未覆盖其文件。
其 manifest 记录 1 页 49 字符、20 显式页 17,771 字符、100 显式页 88,892 字符、100,000 字符样本，
另有 `formatting-source.docx`。显式分页/字符数属于输入描述，不作为浏览器加载性能或导出兼容结论。
实际 Word 页数、端到端耗时、格式/列表和异常浏览器结果见下文；真实 Windows IME 候选选字仍未执行。

| 验收 | 工程侧已观察 | 当前完整结论 |
| --- | --- | --- |
| UI-07 | 1440×900、1024×768、390×844、767/768 往返，70/30/min35/max75，ArrowLeft 70→65；正文/prompt/引擎节点保持 | 已测响应式与键盘调整场景通过；未单列指针拖动验收，修复前编号列表的键盘退出失败见 UI-13 |
| UI-08 | 实际标题/正文/prompt 保存重开、Ctrl+S 两次仅一 PUT、clean shortcut 无新版本 | 已测保存场景通过；序列化超时后的状态标签错误仍待修复 |
| UI-09 | 实际 PUT 503 后输入保留与重试、提交成功响应丢失同操作重试、两标签冲突/副本、序列化与下载适配器抛错保护 | 已测异常与冲突场景通过；操作系统拒绝下载未执行 |
| UI-10 | 取消/放弃/成功保存离开、失败留在对话框、列表搜索焦点、原生 reload/close 提示取消保留输入 | 已测离开场景通过；不据此宣称完整键盘无陷阱 |
| UI-11 | clean export 无 PUT、dirty export 单次保存；实际下载与选中保存版本 SHA-256 一致；四历史版本只读查库一致 | 已测版本导出场景通过；原件不变有仓储测试，未单独验收历史下载路由 |
| UI-12 | 文档 A 重开与冲突副本的 prompt 隔离；发送禁用；主标签 226 次 HTTP、外网 0 | 已测输入/网络场景通过；网络记录未覆盖副标签和独立缩放 profile |
| UI-13 | 实际 60 秒加载/序列化超时、迟到释放、受保护重载、快速切换、cookie 丢失撤下编辑器及原生 200% 缩放已测 | **修复前失败**：编号列表编辑无可发现的键盘退出；序列化超时显示“文档打开失败”。直接 vendor onException、开发 StrictMode 浏览器双挂载未执行 |
| WD-01—WD-04 | 空白新建、中文正文、实际导入修改、格式/列表/表格及 Word 自动往返检查通过 | 自动化和渲染核对已执行；真实 Windows IME、完整编辑动作及人工 Word 验收未完成 |
| WD-05—WD-08 | 保存重开、失败/离开/快速切换/冲突和版本字节场景通过 | 浏览器 StrictMode 双挂载等未执行项保留；不能据子集宣布全部 WD 通过 |
| WD-09 | 合成损坏/超限/外链/不支持结构行为测试通过 | 本轮未重新覆盖所有异常文件的真实浏览器输入 |
| WD-10 | 主标签网络 226 次 HTTP、未授权外网 HTTP 0 | 仅主标签实际记录范围；不推断所有窗口和路径 |
| WD-11 | 本机代码/类型/生产构建/资产冒烟及多视口通过 | 修复前编号列表键盘退出失败；Docker、Linux 未完成 |
| WD-12 | 固定依赖、许可及现有 `/source` 路径未改 | 未以本轮构建命令重做完整分发许可验收 |
| DB-01—DB-04、DB-08 | SQLite 仓储/接口/保留逻辑测试，HTTP 重启/权限检查通过 | Linux 持久性、完整恢复另验；匿名隔离不等于项目授权 |
| DB GaussDB / 容器 | 无实际环境证据 | 未执行，不从 SQLite、驱动配置或历史记录推断通过 |

下载适配器抛错的单元测试与真实浏览器注入均已通过；浏览器发起下载不是设备写盘回执，
不能据无回执断言成功或失败。1—20 页及 100 页/100,000 字符单次实测见下文，不承诺一般性能。
本机未找到 Docker 命令，未安装 Docker。Linux 资产/非 root/卷重启与日志恢复、
GaussDB 实际版本及模式、远程 HTTPS 和完整项目恢复均未执行。
未运行法律业务验证集，本记录所有 UI/WD/DB 和 smoke 结果均不进入业务准确率分母。

## 官方来源与最小偏离

Tasks 3—5 的实施记录明确读取 [官方 Blocks](https://ui.shadcn.com/blocks) 和
[dashboard-01 实际源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/blocks/dashboard-01/page.tsx)。
侧栏、统计卡片和图表不适用本工作区，因此沿用官方组件组合：

- [Resizable](https://ui.shadcn.com/docs/components/radix/resizable)、[wrapper 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/resizable.tsx)、[handle 示例](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/resizable-handle.tsx)、[vertical 示例](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/resizable-vertical.tsx)。
- [Alert Dialog](https://ui.shadcn.com/docs/components/radix/alert-dialog)、[实际示例](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/alert-dialog-demo.tsx)、[组件源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/alert-dialog.tsx)。
- [Input Group](https://ui.shadcn.com/docs/components/radix/input-group)、[textarea/addon 示例](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/input-group-demo.tsx)、[Badge](https://ui.shadcn.com/docs/components/radix/badge)、[Empty](https://ui.shadcn.com/docs/components/radix/empty)、[Button](https://ui.shadcn.com/docs/components/radix/button)。

偏离限于全屏容器/min-size/溢出收敛、窄屏标题独占行和操作换行、Agent 整列独立滚动、
完整标题换行及可见区域焦点；这是操作可达、长标题和缩放要求所需。
恢复官方 grip 样式，不改造 Word 工具栏或供应商画布。Alert Dialog 添加第三个 outline Action，
异步 Action 阻止默认关闭，仅成功后离开；可选 children/关闭焦点回调复用同一错误/副本信息与实际触发器。
沿用系统字体、中性色及组件变体，无新增任意尺寸、颜色、阴影、动画、依赖或比例持久化。
源检查不代替本轮实际可访问性验收。

## 独立 QA 补充

证据来自同一忽略计划目录的 `root-qa-report.md`、`qa-results.json`、`root-qa-frozen-source.json`、
`word-output-observations.json`、`word-capacity-observations.json` 和 `network-summary.json`。
根代理独立操作系统 Edge/CDP 19233，使用隔离 profile 和本轮合成 SQLite；未操作用户文档或会话。
QA 结束核对十个源文件摘要未变，仍为本记录 Build ID；本节只接受该修复前构建，不自动接受未来修复。
最终成功的浏览器脚本均实际执行且退出 0，原始工具失败及修正保留，不拼成零失败历史。

### 浏览器实际结果

- 保存与字节：标题/正文/prompt 编辑后 Ctrl+S 两次一个 PUT，clean save/export 不新增版本；dirty export 一个保存。
  真实下载 SHA-256 等于选中服务端版本。返回/重开保留三类输入。
- 失败与冲突：实际请求 503 保留输入；服务端已提交后响应 503，再用同 operationId 返回同 revision，未新增版本。
  两真实标签的后保存者收到 409，普通保存/导出及快捷键不能覆盖，模态内副本入口可操作，
  副本保持来源基础版本及独立 prompt，原文档较新 revision/hash 不变。
- 离开：取消恢复“文档”触发焦点，放弃/成功保存离开返回搜索框；保存失败留在对话框。
  实际 Page.reload/Page.close 产生原生 beforeunload，取消保留输入。
- 加载/异常：阻塞第二次 DOCX Blob 读取后实测 60,095 ms 超时，保留标题/prompt 并释放引擎，
  迟到释放不挂载旧实例。重载取消保留输入；明确放弃后恢复保存状态且只有一个引擎。
  实际序列化读取被阻塞 60,074 ms 后超时，正文保留；取消重载仍保留，明确放弃后才移除未保存标记。
  Blob.arrayBuffer 抛错恢复后可保存；HTMLAnchorElement.click 抛错可见且不改变已保存版本。
- 会话与切换：延迟真实 GET、取消、释放迟到响应并选择另一文档，最终仍为所选 20 页文档、一个引擎；
  隔离浏览器移除 cookie 后保存撤下受限正文/prompt，显示未保存内容丢失告知，不能继续私有导出。
- 网络：主标签在首次应用导航前至 QA 结束记录 226 次 HTTP、外部 HTTP 0，不记录 headers/cookie/body。
  此记录未覆盖第二个冲突标签及独立缩放 profile，不扩大到未测窗口。
- 输入：CDP imeSetComposition/insertText 产生 compositionstart/end 及中文文字；
  这是 Chromium 组合事件验证，真实 Windows IME 候选选字未执行。

多视口切换的 scrollWidth 等于视口宽，正文/prompt 相同、同一 ProseMirror 节点、一个编辑器/工具栏。
Agent 完整标题换行可读，聚焦及滚动可到输入和禁用发送按钮；长 textarea 高于面板时不要求全高同时可见。
原生 200% 使用独立 profile 的 2× 缩放，无 Emulation override；outer 1440×900 下 inner 705×402、DPR 2、
visualViewport.scale 1，验证标题/正文/prompt、保存与滚动到底部操作可达。
截图均为合成输入，已逐张查看：
[桌面](assets/editor-step-two/desktop.png)、[平板](assets/editor-step-two/tablet.png)、
[窄屏](assets/editor-step-two/mobile.png)、[原生 200%](assets/editor-step-two/zoom-200.png)。

### Microsoft Word 与容量实测

`verify-word-outputs.ps1 -RenderPdf` 退出 0。根代理创建自己的隐藏 Microsoft Word 16.0，
Build `16.0.20430`，只读打开四个实际下载文件，完成后关闭文档和自有应用。
中文条款检查、Agent prompt 未混入、表格“四十五日”、居中标题、加粗/斜体/下划线、
右对齐、项目符号与编号列表均与输入基线相符。Word 渲染 PDF 后用 pdftoppm 输出五页并逐页查看，
未见裁切、重叠或缺字。此为 **Word COM 自动检查 + 代理目视渲染核对**，不是人工操作 Word 验收。

| 下载样本 | Word 页数 | Word 打开/检查耗时 | 观察 |
| --- | --- | --- | --- |
| a-clean-export | 1 | 1,613 ms | 指定中文正文一致，prompt 未混入 |
| a-dirty-export | 1 | 177 ms | 指定修改条款一致 |
| table-export | 2 | 447 ms | 一张表、目标单元格四十五日，周边正文保持 |
| formatting-export | 1 | 583 ms | 标题/文字格式/对齐/两类列表与基线一致 |

容量表是单次本机合成输入观察，不是性能承诺。大文件浏览器 DOM 显示 7 个虚拟页，不代表总页数。
`verify-capacity-word.ps1` 修正工具错误后退出 0；删除唯一一次 7 字符插入后，完整正文与原样本相等。

| 输入 | 浏览器打开 / 编辑 / 保存导出 | 输入→输出字符数 | Word 输入→输出页数 |
| --- | --- | --- | --- |
| 1 页 | 326 / 51 / 334 ms | 49→56 | 1→1 |
| 20 页 | 348 / 48 / 346 ms | 17,771→17,778 | 20→20 |
| 100 页 | 467 / 90 / 351 ms | 88,892→88,899 | 100→100 |
| 100,000 字符 | 435 / 62 / 351 ms | 100,000→100,007 | 67→67 |

1 页样本插入位于第一段末的 offset 8，其余位于文档末；每个样本完整原文均保留。
独立只读 SQLite 检查 `verify-historical-bytes.cjs` 证明后续保存后四个历史版本仍等于实际下载：

| 下载 | 保存版本 ID | SHA-256 |
| --- | --- | --- |
| a-clean-export | `edd20456-8bb3-473e-8a86-8cca16564ece` | `3c3a01d30d15928f76b0ad26f71ff8bc521ddd69e53db53258bc38d2de5ce72f` |
| a-dirty-export | `4f1454ef-8ee5-4b78-b50a-eabb9b8c672d` | `194613c7a4246bed4ff0b41ee124e0b0fee9d2ff4045a2de7f702468dd98711e` |
| table-export | `3bbe70f4-b277-48f5-a76e-52874873693c` | `1581f0ab3e85babaa570a57d2944e0040b1b94ad800bf44773ea40477260f3be` |
| formatting-export | `59ece7ff-9ca4-4f3e-bbd3-7573debf22e3` | `7a3b2c8743fd6240fc49dd9629d67e1c18e96e1c4da0e039a84baef61927dede` |

### 失败、修正与未执行项

以下为冻结修复前构建的实测缺陷，保留原始失败。统一修复及新构建复测另行登记：

1. UI-13 编号列表键盘退出：格式样本最后编号段落经 5 次 Tab、8 次真实 Shift+Tab（modifier=8）仍留在正文；有效 Escape 后 Tab 探针亦未退出。
   原始所谓 Shift+Tab 的 modifier=1 实为 Alt，结果排除；更正探针证明空白段落可用 Shift+Tab 退出，因此不是普遍正文陷阱。
   未带原生 Windows VK 的早期 F6 探针亦排除；`corrected-native-shift-tab-probe`、`corrected-list-shift-tab` 为同一旧构建补充证据，发生于网络记录停止后。
2. 状态准确性：已成功打开后，序列化超时显示“文档打开失败”，而具体 alert 正确显示 Word 导出超时。
   未发生正文丢失，但通用失败状态标签不准确。

工具失败与纠正原样保留：循环 DOM 结果改 Boolean；隐藏 ProseMirror 点击改可见行；
Ctrl+End 缺 VK 导致初始插入位置错误，后用真实 Ctrl+A 修正，初始导出另存且排除目标样本验收；
对话框过早取样改等待焦点/关闭完成；长 textarea 检查改焦点交集与到底滚动；
正文摘要截断改完整正文断言；保存仍在预检改等待 saved；加载阻塞改第二次读取；
Word PowerShell 路径数组括号、原始 base64 读取及重载未完成取样均修正后重跑。
这些工具错误未归类为产品数据丢失。导出超时初次调用曾因自动审批达到使用限额未运行；
用户继续后实际运行成功，不是安全审批拒绝。

未执行：真实 Windows IME 候选选字、开发模式 StrictMode 浏览器双挂载、直接 vendor onException、
步骤一 create/restart 网络失败的浏览器补查、操作系统拒绝下载、人工 Word 验收、
Docker/Linux/非 root/卷与日志恢复、GaussDB 实例与模式、远程 HTTPS、完整项目恢复和业务 AC。
本轮技术实现与部分验证可供审查，完整验收仍未通过。后续新构建的修复结果须单独登记，不能覆盖本轮失败。


## 统一修复轮次（独立于上述冻结结果）

最终全分支审查保留 2 Important / 2 Minor：编号列表键盘退出、冲突后引擎失败并重载导致副本入口消失、失败状态标签、静默 diffcheck 的不存在日志引用。冲突入口问题由源码确定，不能冒充修复前浏览器重现。

本轮实现采用正文 `F6` 转到 Agent 消息、`Shift+F6` 转到文档操作；可见操作提示与编辑器区域的可访问描述说明两者。只处理正文中的显式区域切换，菜单、组合输入和真实操作锁定时不接管，保留 Word 的 Tab/Shift+Tab/Escape。沿用官方 [Blocks](https://ui.shadcn.com/blocks) 及 [dashboard-01 实际源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/blocks/dashboard-01/page.tsx) 的外壳/组件模式；[Button 源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/button.tsx) 的 outline 副本动作保持原样。没有现成 Word 区域切换 Block；最小偏离仅为必要的可访问操作提示和容器 flex 收敛，不新增视觉系统或依赖。

冲突提示从持久 conflict 状态派生，独立于瞬时 error；重载仍保留冲突守卫、所选旧保存版本和副本来源。普通保存/导出仍被禁止。初始或运行中引擎失败均显示“编辑器不可用”，具体原因继续在错误提示中呈现。

旧轮次 diffcheck 为静默成功，实际退出文件是 `diffcheck.exit.txt`、`diffcheck-docs.exit.txt`、`diffcheck-final.exit.txt`；没有相应原始 stdout 日志，不补造其内容。本轮命令、新 Build ID 与后续独立 QA 分开记录；在得到新构建浏览器证据前不宣称四项已复测通过，也不关闭完整 UI/WD 验收。

2026-10-23 统一修复轮次的工程记录：顺序执行 `pnpm check`、`pnpm test`、`pnpm build`、
`git diff --check`，均退出 0；123 项测试，122 通过、0 失败、1 Linux fsync 项跳过。
随后 `pnpm smoke http://127.0.0.1:18083` 退出 0。原始输出及退出码保存于同计划的
`final-fix-evidence/`，不复用旧轮次日志。依赖与锁文件未变，沿用已通过的冻结安装。

新 Build ID 为 `Kkmq_cLPTowCiv8MyX5vW`；运行源码树 102 文件，SHA-256
`f075a037bcccc6fca3c5e7d53104fc05691acd2472fe090427913488eb9b33c6`，
standalone server.js SHA-256 仍为 `0721e57dbb249032bfe319de0a7db94806ad11477b4548da66459102539b8113`。
新 launcher PID `57384`、监听 PID `71084`，UTC `2026-10-23T06:42:45.0271737Z` 启动，
使用相同合成数据库及环境，留给独立 QA；这不是另一次数据库重启验收。
上述工程检查不证明新构建的真实焦点、冲突副本入口或平台验收通过，后续根代理证据另行登记。

### I1 portal integration amendment (2026-10-23)

First fix Build `Kkmq_cLPTowCiv8MyX5vW` failed actual native F6: the editable ProseMirror node is portalled under BODY, bypassing section React handlers. Root actual first-fix QA passed I2 conflict-copy recovery and M1 post-open timeout feedback; raw `root-first-fix-qa.md` and postfix-conflict records remain in ignored evidence. These passes do not establish I1.

Amendment Build `Ezui-rA_YljCHkogVQnN8` moves capture ownership to WordCanvas's per-load native listeners, filtered to the live current editor DOM. Cleanup, composition, visible menus and latest busy/dialog guard protect native editing. Actual editor carries shortcut/help metadata. `portal-fix-evidence` retains scoped baseline diff, source hashes, initial typing failures and successful check/test/build/smoke/diffcheck results. Tests:123 total,122pass,1 existing Windows fsync skip. Scoped independent source review found no new Critical/Important findings. Root actual results below close the scoped keyboard gate; full acceptance is not declared.

### Portal amendment actual results

Build `Ezui-rA_YljCHkogVQnN8`: native Windows VK117 F6 from paragraph → Agent 消息; Shift+F6 → 文档. Imported numbered list retains native indentation after 5 Tab + 8 ShiftTab; both F6 directions exit without changing body. CDP composition blocks exit until commit (not Windows IME candidate-window validation). Actual font listbox retains focus on F6; Escape closes the vendor menu. Full page reload preserves both routes, one editor/toolbar and actual ProseMirror help/shortcut attributes. I1 passes on Ezui; Kkmq's I1 failure remains historical evidence.

Actual save/export revision `668ca861-347a-4bf9-8fbb-c00472f3d9b8`, 3860 bytes, SHA-256 `f7da11d88bec80050801e8fb7f39db6aaf18f2620fa698d1a8f3db4d9de31755`, exactly matches selected saved bytes. Own read-only Word16.0 build16.0.20430 confirms clause present, Agent prompt absent, one page. I2/M1 actual passes belong separately to Kkmq: two-tab409 → copy60090ms timeout → reload → fresh edit → leave-modal copy, original newer bytes unchanged, failed badge 编辑器不可用. No redundant timeout rerun is claimed.

Affected regression passes at1440/1024/767/768/390/back: same body/prompt, one engine/toolbar, no page-wide overflow; title wraps, Agent input and bottom action reachable through own scroll. Keyboard splitter and actual pointer drag pass. Native browser200% (DPR2, inner705×402, visualViewport.scale1) supports body edit/save and Agent bottom-action reachability. Root individually viewed four synthetic-input screenshots:
[桌面](assets/editor-step-two/portal-fix/desktop.png)、[平板](assets/editor-step-two/portal-fix/tablet.png)、[窄屏](assets/editor-step-two/portal-fix/mobile.png)、[原生200%](assets/editor-step-two/portal-fix/zoom-200.png)。

Ignored `root-portal-qa-report.md`, `root-first-fix-qa.md`, `portal-fix-review.md` and `qa-results.json` retain results and corrected probes (background pagination pause, menu focus, reload timing). Independent scoped source review is clean. Full acceptance remains open: Windows IME candidate selection, development StrictMode browser double mount, direct vendor onException, OS download denial, human Word acceptance, Linux/container/non-root/volume recovery, actual GaussDB/HTTPS/full-project restore and business AC are unexecuted. No GitHub CI/commit/push/deployment claimed.
