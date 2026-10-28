# 部署

## 本地镜像

需要可用的 Docker Engine，当前镜像目标平台为 `linux/amd64`。
先复制 `.env.example` 为 `.env`，由负责人登记用途并填写 `ANONYMOUS_DATA_RETENTION_DAYS` 正整数天数。
Compose 原样传递空/非空期限，不提供业务默认值；空值仍可检查健康，但拒绝创建资料。

```bash
docker compose up --build -d
pnpm smoke
docker compose logs app
docker compose down
```

应用监听容器的 `3000` 端口，Compose 只发布到宿主机 `127.0.0.1:3000`。
`GET /healthz` 仅表示应用能响应请求，不检查云服务或业务状态。
镜像以非 root 用户运行，数据库和云服务凭据不参与构建。
Compose 将命名卷 `equilens-data` 挂到 `/data`，SQLite 位于 `/data/equilens.sqlite`；保留该卷才能在重建后恢复文件。
删除日志显式位于同一持久卷 `/data/retention-journal`，另须异地私有备份。可选
`ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` 使用按名称传递：未设时从容器环境省略；不要填空字符串，
仅在负责人另行登记空会话清理窗口后设置正整数。显式空值或非法值使资料就绪失败，健康接口仍独立可用。
不要使用 `docker compose down --volumes` 删除仍需保留的数据。
构建使用 BuildKit 的 pnpm store 缓存，限制并发并将下载超时设为十分钟；仍使用锁定依赖和完整性校验。

## GitHub Actions 与 GHCR

[CI 工作流](../.github/workflows/ci.yml)在 PR、主分支、`v*.*.*` 标签和手动触发时运行。
它安装锁定依赖，执行 lint、类型检查、文档行为测试及生产构建，再构建 Linux AMD64 镜像，启动容器检查
健康接口、首页、CSS、公共资源和非 root 身份。PR 不登录或发布镜像。
两次运行在同一隔离卷保存 SQLite 和删除日志，均显式设置合成测试期限 2 天；重启通过私有 checkpoint
核对 cookie/contextId、固定期限和文档摘要。该夹具值不用于生产，构建阶段不注入期限或访问数据库。
此工作流的配置更新不表示 GitHub CI 已运行；Linux 日志同步、持久性及恢复须在交付版本实际验证。

完成 [Word 编辑规格 §2.1](../spec/03-word-editing.md#21-许可与-api-基线)的许可与对应源码提供安排后，
由仓库管理者设置 Actions 仓库变量 `WORD_EDITOR_DISTRIBUTION_APPROVED=true`。
未设置该变量时，CI 仍执行全部检查与容器验证，跳过 GHCR 登录和发布。
启用发布后，主分支和版本标签只有在上述检查通过后才发布同一个已验证镜像，目标为
`ghcr.io/alaala-daka/equilens`。工作流自动将仓库名转为小写，fork 使用自己的命名空间。
使用自动提供的 `GITHUB_TOKEN`，不需要手工配置发布用 PAT，但仓库策略必须允许该工作流写入 Packages。

| 触发方式 | 发布标签 |
| --- | --- |
| 推送 `main` 或在 `main` 手动触发 | `main`、`latest`、`sha-<完整提交号>` |
| 推送 `v1.2.3` | `1.2.3`、`1.2`、`sha-<完整提交号>` |

版本标签不移动 `latest`；该标签跟踪主分支。正式部署应固定完整提交标签或镜像摘要。
PR 与非主分支手动运行只验证镜像。此配置文件不表示流水线已在 GitHub 运行或镜像已经发布。

首次发布后在 GitHub Packages 确认包的访问范围和仓库关联。包为私有时，部署端需自行配置
具有 `read:packages` 权限的拉取凭据；不要把凭据提交到 Compose 文件。

## ECS

将 Compose 文件放到目标主机，设置 `EQUILENS_IMAGE` 为实际发布的标签或摘要后执行：

```bash
docker compose pull
docker compose up -d --no-build
```

HTTPS 反向代理转发至回环端口，云安全组不公开数据库端口。
当前源码提供 A1 账号登录和独立的匿名文档会话；项目成员权限尚待独立接入，不能用于正式法律业务分析。线上能力须以实际部署镜像为准。
SQLite 模式保持一个实例并挂载持久卷；GaussDB 的连接变量见 [.env.example](../.env.example)。
项目按 AGPL-3.0-only 开源，保留[第三方许可](../THIRD_PARTY_NOTICES.md)，镜像的 `SOURCE_COMMIT` 指向对应源码。
GaussDB、OBS、MaaS、OCR 的区域、连接、权限、费用和完整项目恢复需在业务实现时验证，
相关环境变量随实际接入补充，不提供当前应用尚不读取的配置示例。

## Zeabur

使用 [zeabur-template.yaml](../zeabur-template.yaml) 在已有服务器的新项目中部署一个服务。
模板包含 HTTP 端口 `3000`、SQLite 持久卷 `/data`、精确 origin 与非 root 启动配置。
它使用 CI 验证并公开发布的镜像，不在远端重复安装依赖，不额外创建数据库服务。

```bash
pnpm dlx zeabur template deploy -f zeabur-template.yaml --project-id <project-id> --var PUBLIC_DOMAIN=equilens -i=false
```

导入前将模板 `source.image` 设为已验证的完整提交标签或摘要；Zeabur 不在该字段展开模板变量。
`APP_ORIGIN` 必须等于公开入口 `https://equilens.zeabur.app`，不带末尾斜线；反向代理内部 HTTP 不改变此配置。
`DATABASE_PROVIDER=sqlite`，`SQLITE_PATH=/data/equilens/equilens.sqlite`。只运行一个副本，以 UID 1000 运行。
模板的 `ANONYMOUS_DATA_RETENTION_DAYS` 留空，部署前填写负责人登记的正整数；
`ANONYMOUS_DELETION_JOURNAL_DIR=/data/equilens/retention-journal` 随卷持久保存。
可选空会话窗口未出现在模板环境中；仅登记后手动添加 `ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` 正整数，
不要添加空默认值。模板保留旧的已发布镜像引用，新增配置不能使旧镜像获得本版行为；本轮未部署模板。

编辑器布局更新也需要更新运行镜像，刷新浏览器不会把本地或仓库的新代码部署到 Zeabur。
2026-10-26 核对线上 `/source` 仍指向 `39a97b10ae33f23022fe805cdac5b64786cf8671`，
与模板固定镜像一致，该版本不含后续居中和缩放开关。更新时先确认目标提交的 CI 与镜像发布成功，
将现有服务镜像替换为该提交的精确标签或摘要，保留现有 `/data` 卷和服务环境变量；
不要为了更新代码重新导入模板或新建空卷。更新后检查 `/healthz`、`/source` 重定向到目标提交，
再用独立合成文档验证默认适应宽度、面板拖动、保存重开和导出。
启动时设置 `umask 077`，应用创建自己的数据子目录，实测目录 `700`、数据库文件 `600`；不修改挂载根目录属主。
后续升级固定新的完整提交镜像标签并重部署，保留现有卷；不要重复部署模板创建第二个服务。
域名、HTTPS、API 权限、下载和重启恢复须实测，模板导入成功不等于这些检查通过。
当前线上使用 `39a97b10ae33f23022fe805cdac5b64786cf8671` 镜像，部署与重启验证见[数据库验证记录](reviews/2026-10-22-database-validation.md)。

## SQLite 备份

### 合同审查任务的新增配置

网页审查使用常驻 Node.js 执行器及相同数据库，需部署包含此增量的新构建；现有 Zeabur 模板固定的旧镜像不包含这些改动。
服务端配置 AI_BASE_URL、AI_MODEL、AI_API_KEY，密钥仅作为运行时环境变量，不传构建参数或前端变量。
生产默认 AI_REVIEW_MODE=published，内置规则未发布时会拒绝提交；调试须显式设 debug 并由网页用户确认。
生产必须设置 AI_REVIEW_RETENTION_DAYS（1–365）及经验证的 AI_REVIEW_MAX_PROMPT_CHARS；
AI_AGENT_MAX_CALLS 默认 25，可配置 1–25，累计预算不随恢复重置。Compose 已增加这些环境映射；此轮未运行部署。
原匿名资料期限优先于审查期限，任务不为资料续期；现有未登记资料仍须按匿名维护流程登记，不能通过新任务绕过。
审查与文档共用删除日志重放就绪及会话上下文校验；旧任务缺少 contextId 时拒绝恢复外发，须重新确认新任务。
任务、解析快照、模型交换和报告均在数据库，备份作为私有材料管理。详见[网页审查交接](contract-review-web.md)。

```bash
docker compose exec app node scripts/backup-sqlite.mjs /data/backups/equilens-<timestamp>.sqlite
```

备份脚本使用 Node.js SQLite online backup API，目标必须为新文件，不覆盖已有备份。
将生成文件下载并存放到容器和宿主服务器以外；同一持久卷内的备份不具有异地恢复能力。
恢复时停止全部应用实例，保留现库及其 WAL/SHM 文件，将一致性备份放到新的数据库路径；按下文重放最新删除日志成功后才能启动并验证下载。
会话 cookie 是文件访问凭据，数据库恢复不能恢复已丢失的浏览器 cookie。

## 匿名资料维护与恢复

期限和通知由运维负责人登记，遵循[数据库规格](../spec/04-database-deployment.md#匿名资料的保留与清理)。
本工具不选择生产天数、不补造通知。`ANONYMOUS_DATA_RETENTION_DAYS` 无默认值；
`ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` 为另行登记的可选空会话窗口，无默认值，未设不清理空行。
资料期限缺失或非法时新建、导入、复制返回 503，已有有效登记仍可读、保存、下载；部署环境调整不改变其固定到期日。
用户新建/导入前确认服务端提供的实际到期日期；若提交时日期或策略变化，必须重新确认。
普通会话到期即停止读写和下载，可显式“开始新会话”，新会话无旧资料权限。存量须先通知并登记窗口，
窗口内只读导出，到结束时恢复到期拒绝访问。清除 cookie 不删资料，也不授予新会话旧资料访问权。
启动重放后开放资料访问并执行首轮清理，之后每小时尝试；默认到期后 24 小时的清理目标需要持续运行和故障处置，
不等于延长访问。日志初始化/重放失败阻止资料就绪；后续清理失败保留失败记录，过期访问仍拒绝。
`ANONYMOUS_DELETION_JOURNAL_DIR` 必须是 public 之外的私有持久目录；SQLite 未设时为数据库旁的
retention-journal，GaussDB 必须显式配置。日志文件和目录需分别为 600/700。
实际意图写入或重放须完成日志目录及逐级父目录至文件系统根的同步；权限或文件系统不支持时保持失败，
排查后重试仍重复全部屏障，不以目录或合法文件已存在代替持久化。

工具要求显式 `DATABASE_PROVIDER`，SQLite 还必须显式设置指向既有库的 `SQLITE_PATH`。
以下文件是私有运维材料，不提交 Git；先创建受访问控制的输出目录。源码环境入口为：

```powershell
pnpm exec tsx scripts/anonymous-retention.mts inspect --output data/anonymous-retention-inventory.json
pnpm exec tsx scripts/anonymous-retention.mts enroll --manifest data/anonymous-retention-enrollment.json
pnpm exec tsx scripts/anonymous-retention.mts enroll --manifest data/anonymous-retention-enrollment.json --apply
```

inspect 仅输出 owner 哈希、真实最早创建时间、文档/版本计数与登记状态，独占创建文件，不覆盖。
它不登记存量或清理，数据库 schema 可能按版本迁移。负责人依据清单另存完整 enrollment 数组，
每项精确包含 owner、retentionDays（正整数）、exportUntil、notifiedAt、operator、purpose。
notifiedAt 为实际已提供通知的时间，首次登记的 exportUntil 必须在未来；最早创建时间由数据库确定。
enroll 默认只校验整批并输出 owner 数；显式 apply 才在同一事务登记。未知 owner、重复 owner、
缺通知或变化的已登记记录使整批失败。相同规范化登记重复执行不会续期。

容器不依赖 tsx，使用随镜像提供的 Node 24 工具；例如：

```bash
node scripts/generated/anonymous-retention.mjs --help
node scripts/generated/anonymous-retention.mjs inspect --output /data/private/inventory.json
```

一致性数据库备份和截至恢复时刻的最新删除日志分别复制到服务器外私有存储，记录备份时间、允许恢复窗口、
完整文件清单与 SHA-256。日志仅保留到受影响且允许恢复的备份全部到期；不使用过期备份，不能只恢复数据库行。
恢复前核验日志来源和完整性，负责人制作 replay manifest：

```json
{
  "version": 1,
  "target": { "provider": "sqlite", "path": "/data/restored/equilens.sqlite" },
  "files": [
    { "name": "<真实意图UUID>.json", "sha256": "<该文件原始字节的SHA-256>" }
  ]
}
```

files 必须精确覆盖最新日志目录，不能手工删项使校验通过；空日志仅能在登记确认确实为空时使用空数组。
SQLite path 是新恢复库的绝对规范路径；GaussDB target 为 provider、host、port（数字）、database，
须与显式环境配置一致，不在清单放密码。停机期间在同一受控环境运行：

```bash
node scripts/generated/anonymous-retention.mjs replay --journal /data/latest-retention-journal --manifest /data/private/replay.json
node scripts/generated/anonymous-retention.mjs replay --journal /data/latest-retention-journal --manifest /data/private/replay.json --apply --offline-restored-database
```

默认只核验目录、所有记录/摘要、目标及删除记录冲突并报告 owner 数。
`--offline-restored-database` 是操作者确认已停止全部实例且目标为新恢复库，不能替代实际停机；
禁止对仍提供服务的现库执行。apply 经相同文件/目录同步屏障和应用共享的删除重放函数撤销访问并删除原件/版本。
只有退出码 0 且 applied=true 才能继续启动；缺日志、损坏、冲突、权限、同步或 DB 错误均应保持停机，
保留材料并排查后重试，不能删除失败记录绕过就绪检查。重放幂等；启动时还会再次重放配置目录的最新日志，
因此启动配置须指向已核验的同一最新日志目录。

Windows 合成逻辑测试不能证明 Linux 文件/目录同步与断电恢复；Linux 容器持久化、重启/重放和
GaussDB 实际版本/模式仍需独立验证。以上匿名恢复不代表业务项目、OBS 全项目恢复已实现。

## 受控账号维护与认证就绪

本节适用于含 A1 的源码版本；不表示当前固定线上镜像已更新。账号维护仅由有部署权限的负责人在私有服务器环境执行，
不提供 HTTP 入口，也不自动授予项目权限。actor 是操作者声明，不构成独立身份认证。先备份并核对目标库；
命令会初始化业务 schema。源码依赖 Node.js 24、锁定的 pnpm 和已安装依赖；standalone 镜像未打包此维护入口。

必须显式设置 `DATABASE_PROVIDER=sqlite|gaussdb`。SQLite 必须显式设置绝对 `SQLITE_PATH`，
相对路径或缺省均失败；GaussDB 使用上文连接变量，实际版本/模式须另行验证。工具从当前目录加载 `.env.local`，
已有进程环境优先，执行前核对私有配置，不将连接凭据打印到日志。

以下为 PowerShell 7 源码目录操作。将库路径、账号和 actor 改为已批准的目标；示例不含密码字面量。
创建和重置通过隐藏提示读入，父进程仅把密码写入子进程私有 stdin，不放入历史、环境变量或命令参数。
在不启用终端录制、调试输出或进程内存采集的受控会话执行：

```powershell
$env:DATABASE_PROVIDER = 'sqlite'
$env:SQLITE_PATH = 'C:\EquiLensData\equilens.sqlite'
$action = 'create' # 重置时改为 reset
$account = 'controlled-user'
$actor = 'approved-operator'
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Get-Command node).Source
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
foreach ($item in @((Resolve-Path 'node_modules/tsx/dist/cli.mjs').Path,
  (Resolve-Path 'scripts/manage-account.mts').Path, $action,
  '--username', $account, '--actor', $actor)) {
  $start.ArgumentList.Add($item)
}
$secret = Read-Host '账号密码' -AsSecureString
$address = [IntPtr]::Zero
$process = $null
try {
  $address = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  $process = [System.Diagnostics.Process]::Start($start)
  $process.StandardInput.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($address))
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw '账号维护失败，请检查安全错误和目标配置。' }
} finally {
  if ($address -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($address) }
  $secret.Dispose()
  if ($null -ne $process) { $process.Dispose() }
}
```

不要改为 `echo` 密码、命令行密码参数、环境变量密码或明文临时文件。私有输入中的密码不 trim，
仅移除一个结尾换行；必须为 12—128 个 Unicode 码点且 UTF-8 不超过 512 字节。
缺配置、重复账号、无效输入等均非零退出，成功仅输出完成状态。

不需要密码的操作仍在同一显式数据库配置下执行：

```powershell
pnpm account:maintain disable --username controlled-user --actor approved-operator
pnpm account:maintain enable --username controlled-user --actor approved-operator
```

用独立合成账号验证：登录后保留旧浏览器会话，停用后旧会话访问 session 应为 401；重新启用不能恢复旧会话。
再登录并执行 reset，旧会话应为 401，旧密码不能登录，新密码能登录。不要把 cookie、密码或散列录入检查记录。
会话固定 12 小时，不随访问续期。所有账号共用固定部署来源桶，每 15 分钟 30 次，另有每账号 15 分钟 5 次；
成功失败均计数，重启不清零，可能限制不同用户。不按 IP 限流，也不信任客户端转发头。

`APP_ORIGIN` 必须与浏览器入口严格一致、无末尾斜线。开发使用 `http://127.0.0.1:3000`，
若改用 localhost 或其他端口须同步修改；生产必须配置公开 HTTPS origin，即使代理内部用 HTTP。
生产 cookie 为 Secure/HttpOnly/SameSite=Lax，不能通过关闭 Secure 绕过 HTTPS。
认证 503 须按错误 code 区分：`AUTH_BUSY` 表示密码派生容量已满，稍后由用户显式重试，不自动重试。
`AUTH_UNAVAILABLE` 表示认证不可用：检查 origin 配置、数据库可达性/权限、迁移及启动日志的安全错误。
初始化失败保持不可用；修复配置或数据库后显式重启应用（源码服务停止后重新启动；Compose 使用
`docker compose up -d --force-recreate` 重新注入配置），再用合成账号验证登录、session、退出及旧 cookie 失效。
`/healthz` 成功只表示进程存活，不证明认证 ready；不要通过删库或清空限流绕过故障。
真实 HTTPS、Linux 容器及 GaussDB 验证需分别记录，不以本地 SQLite 测试代替。
