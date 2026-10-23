# 本地复现

适用范围：匿名 DOCX 新建、导入、编辑、保存、导出及合同审查联调。
合同审查依赖有效模型连接；其余业务模块和正式法律验收不在当前实现范围。

## 当前机器启动

当前目录 `D:\EquiLens-restore` 的 `.env.local` 已配置本地 SQLite、7 天资料/审查记录保留期限及 debug 审查模式。
模型地址、模型名称、密钥沿用本机原有配置；`.env.local` 不进入 Git。

在 PowerShell 中逐行运行：

```powershell
cd D:\EquiLens-restore
pnpm dev
```

按终端显示的地址访问，默认 [http://localhost:3000](http://localhost:3000)。
同一次使用保持相同的域名和端口；localhost 与 127.0.0.1 的浏览器会话独立。
启动命令会生成 DOCX 校验、合同解析和保留维护程序，再启动 Next.js；不直接使用 `next dev`。
按 Ctrl+C 停止服务。配置变更后需重启。

复现数据位于 `data/local-repro/equilens.sqlite`，删除日志位于 `data/local-repro/retention-journal`；
原 `data/equilens.sqlite` 不会被修改，也不会把旧资料自动迁入新库。
7 天仅为当前本地合成资料联调用途的配置，不是生产默认策略。新建/导入前仍须确认实际到期日。
清除浏览器 cookie 后无法通过文件名取回原会话的文件，需保留的文件请及时导出。

## 在其他目录或机器准备

使用 Node.js 24 和项目固定的 pnpm 11.6.0，先运行：

```powershell
pnpm install --frozen-lockfile
```

将 `.env.example` 复制为 `.env.local`，填入本机授权的模型连接信息；不要覆盖已有密钥。
下列配置对应本地联调；把两个绝对路径中的项目目录替换为实际目录：

```dotenv
DATABASE_PROVIDER=sqlite
SQLITE_PATH=D:/EquiLens-restore/data/local-repro/equilens.sqlite
ANONYMOUS_DATA_RETENTION_DAYS=7
ANONYMOUS_DELETION_JOURNAL_DIR=D:/EquiLens-restore/data/local-repro/retention-journal
AI_REVIEW_MODE=debug
AI_REVIEW_RETENTION_DAYS=7
AI_REVIEW_MAX_PROMPT_CHARS=240000
AI_AGENT_MAX_CALLS=25
```

`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 使用你有权访问的服务，密钥只写在 `.env.local`。
提示上限须符合实际模型容量；240000 是应用联调上限，不表示任意模型均能接收该长度。
本地通常不设 APP_ORIGIN，让应用按实际 Host 校验；不填远程线上域名。
ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS 不使用时整项省略，不写空值。
随后运行 `pnpm dev`。

## 从文件走通

1. 打开首页，点击「新建文档」并确认保留期限；输入内容或备注后保存。
2. 返回列表并重开，核对已保存内容；点击「导出 Word」取得已保存版本。
3. 也可点击「导入 Word」，选择仓库合成样本 `tools/contract-review/fixtures/sample-contract.docx`。
4. 打开样本，在右侧「合同审查」确认地域、未核对资料提示及外发授权。未保存的修改需先保存。
5. 点击「开始审查」才会向配置的模型服务发送材料并产生请求费用。关闭页面不会取消已提交任务。
6. 重新打开文档可查看任务进度、报告、待核实项和原版本引文；修改后保存需重新确认外发授权。

规则状态不需要改为已发布。debug 使用未停用的待核对规则，持续保留未核对标记；
published 只接收完成核对后发布的资料，目前内置资料会被拒绝。两者的处理流程相同，资料准入门槛不同。
没有模型密钥、无访问权限、超时、超出预算或输出无效时可能失败或部分完成，不能保证任意输入均成功。

## 不调用真实模型的检查

```powershell
pnpm check
pnpm test
pnpm review:contract:example
pnpm smoke http://localhost:3000
```

测试和 example 使用离线合成回复；smoke 只检查本地服务。
真实服务连通测试为 `pnpm ai:smoke`，会发送一次固定合成消息并可能产生费用，不属于离线检查。
应用验证记录见 [本地启动验证](reviews/2026-10-23-local-development.md)。
