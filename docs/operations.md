# 运维

备份、数据恢复与账号维护。首次部署见[部署说明](deployment.md)。

## SQLite 备份

```bash
docker compose exec app node scripts/backup-sqlite.mjs /data/backups/equilens-<timestamp>.sqlite
```

备份脚本使用 Node.js SQLite online backup API，目标必须为新文件，不覆盖已有备份。
将生成文件下载并存放到容器和宿主服务器以外；同一持久卷内的备份不具有异地恢复能力。
恢复时停止全部应用实例，保留现库及其 WAL/SHM 文件，将一致性备份放到新的数据库路径；按下文重放最新删除日志成功后才能启动并验证下载。
会话 cookie 是文件访问凭据，数据库恢复不能恢复已丢失的浏览器 cookie。

**只备份数据库不够。** 项目原件、核验证明、导出文件与删除日志不在 SQLite 中；只恢复数据库会得到
无法打开原件/下载导出的项目。完整备份集必须同时包含数据库、私有对象字节清单与摘要、删除日志、
应用/模板版本、非敏感配置名清单与密钥恢复说明，见下文「完整项目备份集与恢复演练」。

## 完整项目备份集与恢复演练（A5）

本节是本地可执行的验收口径，**不等于**真实 OBS/GaussDB/Linux 容器/异地备份验收。完整项目恢复要求
停止写入后取得一致备份，恢复前重放删除日志，恢复后清除过期租约与旧执行令牌，不信任旧进程。

**本地开发配置**（源码环境；容器内使用等价的生成入口另见各命令说明）：

```powershell
$env:DATABASE_PROVIDER = 'sqlite'
$env:SQLITE_PATH = 'C:\EquiLensData\equilens.sqlite'
$env:EQUILENS_SYNTHETIC_STORAGE = '1'          # 仅开发对象存储；生产 fail-closed
$env:EQUILENS_DEV_OBJECT_STORE = 'C:\EquiLensData\dev-objects'
$env:PROJECT_DELETION_JOURNAL_DIR = 'C:\EquiLensData\project-deletion-journal'
$env:APP_ORIGIN = 'http://127.0.0.1:3000'
```

**1. 合成完整项目 seed（可复现，仅合成数据）**

```powershell
pnpm exec tsx scripts/seed-restore-project.mts seed --root "$env:TEMP\equilens-r6-a5\seed"
```

生成新根目录（数据库 `equilens.sqlite`、`objects/`、`deletion-journal/` 与私有 `checkpoint.json`）：
账号/成员、项目与预算、已解析材料、C4 字段+要求集+确定性比较成果（真实执行器运行、校验有效、已复核）、
C5 拟约定输入+待核对草稿+版本化 Word 导出、任务历史，以及第二个用于删除重放演练的项目。
命令拒绝覆盖已存在目录；密码只经 `A5_SEED_PASSWORD`/参数传入，不写入清单。

**2. 一致备份集（必须停止应用写入）**

```powershell
node scripts/backup-objects.mjs --database <现库路径> --objects <dev-objects 目录> `
  --journal <删除日志目录> --out <新的备份目录> --app-version <提交号>
```

工具先尝试数据库 EXCLUSIVE 写锁；仍有写入时直接失败（quiesced 备份要求），随后用 SQLite 一致性快照
生成 `database.sqlite`，并逐个对象校验/复制（对象头 SHA-256 与实际字节、对象键与路径一致），复制最新
删除日志，写出 `manifest.json`（version/root/objects[key,sha256,size]/database/journal/app/模板版本/
配置名清单/密钥恢复说明/迁移账本）。备份集不得留在同机卷作为唯一副本。

**3. 恢复到新根目录并验证**

```powershell
node scripts/restore-verify.mjs --set <备份目录> --checkpoint <checkpoint.json> `
  --database <新库路径> --objects <新对象目录> --journal <新日志目录> `
  --journal-source <最新删除日志目录>
```

脚本校验备份集 manifest/数据库摘要/integrity_check/迁移账本、对象清单完整覆盖与逐字节摘要、复制到新路径
并再次校验，然后把恢复库中 `running` 在途任务改为 `recovered` 排队并清除旧执行令牌与租约（不信任旧进程），
强制调用 C7 `replay --offline-restored-database` 重放删除日志；随后核对已删项目墓碑/删除记录、所有含
`project_id` 表的行清理、删除项目对象键清理、保留项目数据与对象存在。给出 `--base` 时再按纯 HTTP 验证：
登录、原件字节+sha256、解析来源逐字、成果/复核、导出下载 sha256、任务/预算历史、已删项目拒绝访问且列表不可见
（对非成员统一 403、不暴露存在性；超级管理员等路径按 404 语义）与 no-store。
`--use-restored` 用于验证已经启动服务的恢复根目录（数据库文件摘要因 WAL/会话写入变化时改为校验
integrity_check 与冻结迁移账本）。
该模式的直接数据库检查只读打开数据库，保留合法在途任务及租约，禁止与 `--replay-cli`、`--replay-args`、
`--inject-stale-attempt` 等写入选项合用。在线 HTTP 验证须在离线恢复成功、启动服务后另行执行；
HTTP 登录按正常认证流程创建会话，不重置业务任务或租约。
离线恢复必须显式提供存在的最新日志源目录；确无删除意图时使用空目录。最新日志必须包含备份内每个既有意图，
文件内容不得改变。脚本先完整预检日志结构和数据库冲突，再复制、清理旧执行令牌并执行离线重放；任何一步失败均不得启动服务。
备份与恢复还按数据库核对材料原件、项目文档历史版本及已完成导出的对象引用、摘要和已登记大小；
丢失对象、选错对象目录或摘要不符均拒绝完整备份/恢复。未完成上传和导出意图不要求对象已经存在。
应用重启或明确离线重放会恢复上个进程中断的回收领取，保留逐对象清理检查点；普通在线重试不抢占当前执行。
历史已删除但缺删除记录的项目由后续有界清扫持续补登记。维护 CLI 的默认 replay 只读预检也会拒绝数据库冲突，
不初始化 schema 或改变备份库日志模式；实际应用重放仍须 `--apply --offline-restored-database`。

**4. 迁移账本与卷式重启**

```powershell
pnpm exec tsx scripts/seed-restore-project.mts migrations --out <migration-reference.json>
node scripts/smoke-database.mjs --verify-migrations <migration-reference.json> --database <库路径>
node scripts/smoke-database.mjs --integrity --database <库路径>
node scripts/smoke-database.mjs http://127.0.0.1:3000 <checkpoint>          # 首次，写入私有快照
node scripts/smoke-database.mjs http://127.0.0.1:3000 <checkpoint> --verify # 卷式重启后
```

迁移验证覆盖空库应用、重复启动、0001 与 0004—0012 冻结摘要、0013 存在性、历史漂移/编号缺口拒绝与失败回滚；
`--verify` 跨进程重启时还校验数据库 integrity_check/外键。

**5. 删除/保留/重放边界**

- 删除先撤销在线访问（每请求按 `retention_until`/删除状态判定），同一事务写状态与删除记录，再落删除日志、
  清对象、按序清行；日志不可写时不删对象且保持撤销；项目行保留为墓碑，永不物理删除。
- 恢复旧备份后必须重放**截至恢复时刻的最新删除日志**：已删项目保持不可见（非成员统一拒绝、不暴露存在性），不得复活；删除后取得的备份重放应为
  no-op。缺少日志、损坏、冲突或仍提供服务时不得启动。
- 合成项目不随保留期自动清扫（需显式删除；归档入口未交付）；真实授权项目到期由清扫进入删除流程。
- 删除状态 `GET /api/projects/[id]/deletion` 只对删除请求人/超级管理员（以及成员行未清理时的当前管理员）可读，
  只返回状态/尝试/时间，不返回项目内容。

**6. 双层容量 harness（合成，不承诺 SLA）**

```powershell
pnpm exec tsx scripts/seed-restore-project.mts capacity-repository
pnpm exec tsx scripts/seed-restore-project.mts capacity-http --database <库> --checkpoint <checkpoint> --base http://127.0.0.1:3000
```

仓储层用注入时钟验证生产限额（每账号 2 个未终结任务、全局队列 10、幂等/409/429、单执行租约与过期恢复）；
HTTP 层由 CLI 创建 5 个合成账号并记录并行请求耗时/错误/用量。两者都是本机合成测量，不是生产容量或 SLA 证明。

**边界**：本节命令在 Windows + SQLite + 开发文件对象存储上验证；真实 OBS 私有桶/版本保护、容器卷与
Linux fsync、GaussDB 真机、GitHub CI 运行、公网 HTTPS、ECS 外异地备份与 24 小时备份窗口仍属外部缺项。
备份耗时与损失窗口只报告本次实测值，不代表线上恢复目标。

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
相对路径或缺省均失败；GaussDB 使用 [.env.example](../.env.example) 中的连接变量，实际版本/模式须另行验证。工具从当前目录加载 `.env.local`，
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

## 预设超级管理员

可选在部署平台秘密配置中同时注入 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD`，无默认值。
均不配置时跳过；缺一、空值、非法用户名或不符合上述密码限制时认证拒绝 ready。值不得进入命令参数、源码、镜像或日志。
初始化仅在显式运行生命周期、迁移后且 ready 前执行。账号、角色、bootstrap 审计和一次性标记原子提交；失败全部回滚。
无完成标记而同名账号已存在时拒绝初始化，不接管该账号。并发失败实例保持未就绪，检查安全错误后显式重启。

成功后移除两项秘密配置。保留或修改配置不会重置密码、恢复停用账号、重新提权或创建第二个账号；持久标记随数据库备份和恢复。
勿删除标记恢复权限。忘记密码时沿用上述私有 stdin reset 流程，reset 保留角色；需恢复管理角色时使用私有运维命令：

```powershell
pnpm account:maintain grant-admin --username controlled-user --actor approved-operator
pnpm account:maintain revoke-admin --username controlled-user --actor approved-operator
```

角色操作不接受密码，沿用显式数据库及绝对 SQLite 路径限制；角色变更、审计及撤销该账号全部会话同事务完成。
需重新登录使用新角色。disable/enable/reset 保留角色，enable 不恢复旧会话。
登录和 session 响应含服务器读取的 user.role；管理守卫每次检查当前会话及角色。未提供网页或公众 HTTP 账号维护。
正式项目授权仍待接入和验收；超级管理员不接管匿名资料。GaussDB、Linux 容器及有效公网 HTTPS 另行验证。
