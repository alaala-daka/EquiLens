# 开发对象存储持久化与文档错误提示修复

日期：2026-10-29。阶段：Demo 工程基础（第三轮后续修复）。分支 `alaaladaka/round3/review`，基线 `ea90fc3`。

## 问题

本地开发使用进程内存合成对象存储：dev 服务重启后数据库记录仍在，但材料原件、项目文档版本与导出文件的对象字节全部丢失。项目文档内容接口因此返回 503，前端却把所有非 2xx 响应统一显示为「文档操作失败，请重新确认访问权限。」，把存储不可用误报成权限问题。

## 变更

| 文件 | 内容 |
| --- | --- |
| `src/server/storage/file-store.ts` | 新增开发文件对象存储：校验对象键与输入；先写临时文件，再以不覆盖已有对象的原子链接提交；读取校验长度与 SHA-256；损坏或篡改对象拒绝返回；不提供公开 URL |
| `src/server/storage/runtime.ts` | 仅 `NODE_ENV=development` 且 `EQUILENS_SYNTHETIC_STORAGE=1` 时启用文件对象存储，默认 `data/dev-objects/`，可用 `EQUILENS_DEV_OBJECT_STORE` 覆盖；生产与测试环境继续 fail-closed |
| `src/server/storage/file-store.test.ts`、`runtime.test.ts` | 覆盖重启后字节保留、幂等/冲突、非法键/输入、篡改拒绝、跨进程持久化 |
| `src/lib/business/documents-client.ts` | 401/403/409/503 分别使用对应固定文案，并优先采用服务端返回的固定产品信息；503 不再显示权限提示 |
| `src/lib/business/documents-client.test.ts` | 覆盖 503 存储文案、409 版本文案、非 JSON 错误体的状态兜底，以及权限失效通知范围 |
| `spec/04-database-deployment.md` | 增加「开发私有对象存储」约束：开关、目录、校验、重启保留、不具 OBS 语义、生产 fail-closed |
| `README.md` | 更新开发对象存储运行说明 |

## 本地旧数据清理

旧的合成材料、项目文档、审查任务与导出记录已失去对象字节。先备份数据库文件到 `.superpowers/backup-2026-10-29/`（SQLite + WAL + SHM），再在同库清理：材料 4、材料版本 4、上传意图 4、解析快照 4、来源片段 936、任务 7（任务预算预留 30 条随外键级联删除）、项目文档 2、项目文档版本 2、成果 1、成果版本 1、成果导出 2。保留账号、项目、成员、项目预算（已计费 3600 分，未重置）、项目审计与匿名工作台文档；清理后 `PRAGMA foreign_key_check` 无违例。

## 工程门禁

Windows，Node.js 24.14.1，pnpm 11.6.0。以下均为本地结果，不代表 GitHub CI：

| 命令 | 结果 | 原始输出 |
| --- | --- | --- |
| `pnpm check` | exit 0；ESLint、Next route typegen、tsc | 本地命令输出 |
| `pnpm test` | exit 0；681 项，680 通过、0 失败、1 跳过 | `.superpowers/fix-object-store-test.log` |
| `pnpm build` | exit 0 | `.superpowers/fix-object-store-build.log` |
| `pnpm smoke http://127.0.0.1:3000` | exit 0；健康、页面、样式、公共资源 | `.superpowers/fix-object-store-smoke.log` |
| `git diff --check` | exit 0 | 本地命令输出 |

## 实际持久化验收

环境：本地 dev（`http://127.0.0.1:3000`），本地 SQLite，`EQUILENS_SYNTHETIC_STORAGE=1`，开发对象目录 `data/dev-objects/`，项目「集成分包项目」。合成 DOCX `fixture-c.docx`，sha256 `737a61954e1d954ab2603b00806784ac29954a11609d8432171a8676a97d103b`。

1. 启动 dev 服务，以账号 `123` 登录，上传合成 DOCX 并等待解析成功；导入项目文档，再保存一个修订版本（文档 `b210cb94-928a-445f-b903-b9484c232280`，修订版本 `e29ea6e1-7f93-4b65-bdbf-ccd32528c3b4`）。上传接口与保存接口均返回成功，磁盘出现 2 个对象文件，对象头摘要与实际字节 SHA-256 一致。
2. 结束 dev 服务进程并重新启动。重新登录后校验：材料原件、文档当前版本视图、保存版本内容、原始版本内容四类请求全部 200，SHA-256 与重启前完全一致；磁盘对象文件仍为 2 个。脚本输出 `RESTART_PERSISTENCE_PASS`，状态与结果见 `.superpowers/verify-persistent-objects/state.json`、`after-restart.json`、`phase1.log`、`phase2.log`。
3. 浏览器（headless Edge）重新登录后从「文档」打开该已保存文档：编辑器加载《房屋建筑机电安装专业分包合同（合成样本·第三轮验收C）》全文，状态为「已保存」，页面无错误提示，无 4xx/5xx 网络响应。截图：`.superpowers/verify-persistent-objects/document-open.png`。
4. 错误文案验证：临时移走上述保存版本的对象文件后重新打开文档，页面提示「文档存储暂不可用，请稍后重试。」，不再出现「重新确认访问权限」或权限失效文案；恢复对象文件后再次执行第 2 步校验全部通过。截图：`.superpowers/verify-persistent-objects/document-storage-unavailable.png`。

## 未完成与限制

- 开发文件存储不是真实 OBS：没有桶权限、对象版本、生命周期、跨实例一致性或备份语义，仅用于单实例本地开发与合成材料联调。
- 生产环境仍 fail-closed；真实 OBS、GaussDB、Linux 容器、完整项目恢复与业务质量集未验证。
- 本记录只是修复验证，不表示 AC-01—AC-26 或整项 UI 验收通过；旧记录清理属于本地开发数据处理，备份仅保留在本机忽略目录。
