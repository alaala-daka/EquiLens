# 数据库与单体部署

## 范围与选择

本规格负责文档的服务端保存、数据库选择与 Zeabur 单实例部署。环境变量 `DATABASE_PROVIDER`
只接受 `sqlite` 或 `gaussdb`，默认 SQLite；无效配置和连接失败必须报错，禁止回退到内存或另一数据库。
SQLite 使用 Node.js 24 的 `node:sqlite`，GaussDB 使用华为维护的 `gaussdb-node`，不引入 ORM。
GaussDB 的目标是集中式实例，版本、兼容模式和真实服务的往返验收独立记录；本机 SQLite 测试不能替代它。

## 数据与权限

- 新建、导入、读取和保存文档使用同源服务端 API。持久化元数据、不可变 DOCX 版本、导入原件及来源关系。
- 保持 Word 编辑规格的摘要校验、原件保护、基于旧版本的冲突检测和操作 ID 幂等语义。
- 服务端重新校验文件大小、DOCX 内容和输入结构，不信任客户端校验。保存版本和当前版本指针在同一事务提交。
- 无账号阶段使用随机 256 位 HttpOnly 会话 cookie；数据库只存其 SHA-256 标识。所有资源按该标识隔离。
  cookie 使用 SameSite=Lax，HTTPS 下 Secure。写操作核对同源 Origin；其他会话的文档、版本和复制来源不可访问。
- 此会话不替代产品的项目成员、账号登录与撤销机制，不计入 AC-01 验收。清理 cookie 将失去该会话访问入口。
- 浏览器已有 IndexedDB 原件和版本不删除、不自动上传；需要迁移时由用户导出再导入。
- 失败仅返回明确的操作信息，不将数据库连接串、密码、SQL 或底层错误发给浏览器。
- 上传校验在最多一个短生命周期子进程内执行，堆上限 192 MiB、超时 15 秒；忙时拒绝并允许重试。

## 业务项目接入边界

业务步骤按[产品规格第 3 节](01-product.md#3-用户与权限)实现账号及项目成员授权，
不能把现有匿名会话隔离直接当作该授权。匿名文档不自动归属项目；需要用于业务时，
由用户导出后在获授权项目中重新导入，登记来源及处理授权，不凭旧 cookie 或资源 ID 批量迁移。
重新导入建立独立项目副本，按产品规格 §10.5 的项目保留策略处理；匿名副本仍按下节处理，
清理匿名副本不得删除或改写已重新导入项目的原件、版本和成果。

## 匿名资料的保留与清理

本节的固定期限、到期守卫、清理生命周期及维护命令已有实现和 SQLite 合成逻辑测试；
Linux 日志持久性、容器恢复及 GaussDB 真机验收仍需独立记录。匿名资料不能只依赖 cookie 有效期保留。
项目负责人须在部署时登记保留用途和 `ANONYMOUS_DATA_RETENTION_DAYS`，值为正整数天数，无默认值；
文档服务缺少或无法解析该配置时拒绝新建、导入与复制，并返回操作错误，不默认无限保留。
构建和健康检查不因该配置连接数据库或启动清理；实施时同步 `.env.example`、README 和部署操作说明，
配置、操作与实际验证结果必须分开记录，未运行的环境不得宣称验收通过。

同一匿名会话以最早文档创建时刻加登记天数计算并持久化固定到期日及策略版本。
后续新建、导入、保存、访问和复制沿用该到期日，不隐式续期。调整部署配置不自动修改已登记期限。
新建和导入前由服务端提供实际到期日供用户确认；确认不替代材料授权，也不承诺清除 cookie 后仍可恢复访问。

到期后立即拒绝该会话旧资料的读取、预览、保存、复制和下载；不能依靠缓存或旧 cookie 继续访问。
用户可显式“开始新会话”：服务端签发全新的会话标识和 cookie，首次创建资料时登记新到期日。
新会话列表为空，不继承旧资料、输入、资源权限或剩余期限；旧会话到期日和清理记录保持不变。
不能在旧会话中继续创建已到期资料，也不能通过仅刷新旧 cookie 为旧资料续期。
应用通过显式 Node.js 运行生命周期初始化清理工作，在启动后及定期检查时处理到期会话，
默认在到期后 24 小时内清除在线原件、历史版本、会话输入和临时派生数据，不增加独立服务。
清理以服务端会话标识和到期日执行，不依赖浏览器在线；失败保留安全错误和重试记录，访问仍保持撤销。
删除记录及备份到期、恢复后的删除重放遵循产品规格 §10.5，不因恢复旧备份重新公开已到期资料。

对启用本策略前的存量，运维负责人须先登记会话最早创建时刻、适用期限及有具体结束日期的导出窗口，
并提供到期通知；不能把没有既有期限的数据视为早已同意立即清理。
若按创建时间计算已到期，在迁移窗口内冻结写入，仅原会话可读取并导出；窗口结束后拒绝访问并清理。
该迁移例外优先于普通到期拒读规则；无原 cookie 不授予替代访问权限，导出窗口不成为隐式永久续期。

### 会话线协议与确认

共享线类型位于 `src/lib/documents/session-types.ts`；服务端记录与纯策略位于
`src/server/documents/retention-policy.ts`。随机展示标识 contextId 不替代 HttpOnly cookie 授权。
响应均私有 no-store；写入保持同源检查。文档请求必须携带 `X-Document-Context`，响应回传相同 header。

| 接口 | 请求 | 响应与条件 |
| --- | --- | --- |
| GET `/api/document-session` | 当前 cookie，可取消 | 200 AnonymousSessionView；无 cookie 签发新身份，数据库仅保存哈希 |
| POST `/api/document-session` | 同源 JSON `{ action: "restart", expectedContextId }` | 仅 expired 可成功；200 新 view 与 cookie，旧 owner 期限及删除记录不变 |
| GET 文档列表/版本 | cookie 与上下文 header | 保留现有数组/文档形状；仅合法 read |
| POST 文档 | 现有字段、上下文 header 与 retentionConsent | authored/imported 必须确认；active copy 沿用固定期限，仍检查配置及来源 |
| PUT 文档 | 现有保存字段与上下文 header | 合法 save，保留基础版本与 operationId 规则 |

RetentionConsent 为 `{ contextId, policyVersion, expiresOn }`，expiresOn 是服务端给出的 Asia/Shanghai
日期 YYYY-MM-DD。new 尚无资料时 expiresAt=null，confirmation 按当前提交候选时刻计算日期；首次事务
以真实创建时刻固定期限。提交时北京时间到期日期或 policyVersion 与确认不同，写资料前返回
RETENTION_CONFIRMATION_CHANGED 并重新确认，不伪造创建时间。active 使用已登记期限及策略版本。

AnonymousSessionView 包含 contextId、state、expiresAt、exportUntil、canRead、canCreate、canSave、
canRestart、confirmation，以及可选 `{ code, message }` issue。状态优先级：已撤销（含删除重放）为 expired；
未登记存量为 legacy_pending；已到期且窗口未结束为 legacy_export；其余已到期为 expired；否则按是否
有 firstCreatedAt 为 new/active。恰好到期即拒绝普通访问，恰好窗口结束即 expired，不回到 new/active。
legacy_export 仅 read/download，客户端不挂载编辑器；expired/revoked 拒绝所有文档操作，仅配置有效时可 restart。
read 覆盖列表与版本读取；download 仅取得已保存版本的同一份字节。

缺配置禁止 create/copy，既有有效登记继续 read/save/download；readPolicy 仅配置错误返回 null，
其他异常按 DB-04 故障处理。配置仅接受十进制正整数字符串，不 trim、不回退，使用安全整数并拒绝 Date
溢出；版本为 `anonymous-v1:${days}`。纯策略只读取传入 now，不访问数据库，不在导入时读取环境或启动清理。

错误 JSON 为 `{ error, code, session? }`，不得返回 SQL、owner 哈希或 cookie 原值：

| HTTP | code | 条件 |
| --- | --- | --- |
| 503 | RETENTION_UNCONFIGURED / LEGACY_RETENTION_PENDING | 配置缺失或非法 / 存量未登记 |
| 410 | RETENTION_EXPIRED | 到期或撤销 |
| 400 | SESSION_CONTEXT_REQUIRED | 缺少上下文 |
| 409 | SESSION_CHANGED | 上下文变化 |
| 422 | RETENTION_CONSENT_REQUIRED | 缺少确认 |
| 409 | RETENTION_CONFIRMATION_CHANGED | 确认日期或策略变化 |
| 403 | RETENTION_READ_ONLY | 窗口内写入 |
| 409 | SESSION_RESTART_NOT_ALLOWED | 非到期重开 |
| 409 | REVISION_CONFLICT | 原保存冲突；客户端按 code 区分，不将所有 409 当作保存冲突 |

### 会话存储与事务

schema v2 在原文档与版本表之外添加下列两表；空库直接初始化为 v2，v1 仅添加表、索引并更新
schema 版本，不重写原件、版本 payload 或 metadata。未知版本拒绝数据访问。

```sql
CREATE TABLE equilens_document_sessions (
  owner VARCHAR(64) PRIMARY KEY,
  context_id VARCHAR(36) NOT NULL,
  registered_at TEXT NOT NULL,
  first_created_at TEXT,
  retention_days INTEGER,
  expires_at TEXT,
  policy_version VARCHAR(64),
  export_until TEXT,
  legacy_pending INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  revoked_at TEXT,
  registration TEXT
);
CREATE TABLE equilens_retention_deletions (
  id VARCHAR(36) PRIMARY KEY,
  owner VARCHAR(64) NOT NULL,
  expires_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reason VARCHAR(32) NOT NULL,
  completed_at TEXT
);
CREATE INDEX equilens_session_expiry ON equilens_document_sessions(expires_at);
```

`registered_at` 仅供服务端按运维登记窗口清理仍无文档的空会话行；不成为资料期限起点，也没有默认
保留窗口。首次查看无资料 owner 创建独立 UUID contextId 与登记时间，firstCreatedAt/expiresAt 为 null。
已有文档而未登记的 owner 创建 legacy_pending 行，业务请求不得自行补期限。owner 主键竞争插入失败后，
回滚并重新读取，不使用未经验证的 UPSERT。`revoked_at` 映射 revokedAt，删除记录重放优先撤销访问。

`DocumentSessionRepository(database, { now, readPolicy })` 接收可注入时钟与策略读取函数，提供 view、
assertContext、guardIn、confirmCreateIn、registerLegacy、expiredOwners；guardIn 与 confirmCreateIn 接收
调用方的同一个事务 Connection。`DocumentRepository(database, sessions)` 必须显式注入会话仓储。
list/open/save/create 分别在资源事务内执行 read/read/save/create 守卫；source=copy 推断为 copy，
不要求新确认，仍校验同 owner 的来源版本。来源权限检查在到期守卫之后、确认之前执行，跨 owner 维持 404。
HTTP 层使用 assertAccess 在独立短事务中复用 guardIn，上传校验后再次检查写权限；
文档和列表响应序列化后再次检查 read 与上下文，跨越期限的响应不得返回文档字节。
一次资源动作只结算一个守卫动词，客户端用途声明不替代服务端动作判断。

Blob 编码在事务外完成。confirmCreateIn 仅取一次 now，该时刻同时用于文档、首版本和首次期限。
首次期限通过 revision 条件更新，失败重新读取并校验既定期限及确认；首文档与期限一起提交，失败一起回滚。
后续配置变化不修改已登记期限；配置缺失仍拒绝 create/copy，但不阻止有效登记的 read/save/download。

存量登记输入为 `{ owner, retentionDays, exportUntil, notifiedAt, operator, purpose }`；首次仅允许未登记存量，
按已有文档最早创建时间计算期限。天数须有效，通知时刻不得晚于登记时刻，导出结束须晚于登记及通知时刻，
operator/purpose 非空。registration 保存这些安全登记字段的 JSON，与清理记录日志使用相同口径；
不得包含 cookie 原值、文档内容或凭据。相同规范化登记可幂等重放，不更改期限或 revision；
已登记后不同输入返回 409 冲突，撤销会话仍拒绝登记。登记不改写文档、版本及原创建时间。
expiredOwners 仅返回已登记且到期、导出窗口结束的会话及已撤销会话，不清理未通知的 legacy_pending。
已完成删除且没有残留文档/版本的墓碑不占用每轮 100 个候选名额，避免阻塞后续到期会话。

### 删除日志与运行就绪

删除意图先写入独立私有目录，再执行逐 owner 短事务；事务登记 deletion、固定 revoked_at、删除 revisions
及 documents（其中含输入/prompt），最后设置 completed_at。当前没有单独持久化的临时派生表；新增此类存储
必须加入同一清理边界。日志重放按同样事务执行，恢复旧数据库后先重放最新日志才允许文档访问。
意图仅含 UUID id、SHA-256 owner、expiresAt、requestedAt 和固定 reason=anonymous-expired。
损坏、部分写入、非法文件名及不能完成文件/目录同步均使数据就绪失败，不可作为空日志跳过。
重试复用同 owner/期限的合法意图，并重新完成文件及目录同步屏障。
日志目录可递归创建；每次实际写入或读取已有意图用于重放前，须同步日志目录及其逐级父目录至文件系统根，
使新建目录链的各目录项持久化。失败后即使目录和合法意图已存在，重试也不得跳过这些屏障。
空日志初始化不要求意图同步；任何实际意图的文件或目录同步不受支持均须失败关闭。

`ANONYMOUS_DELETION_JOURNAL_DIR` 指定独立持久目录；SQLite 未指定时取数据库同目录下 retention-journal，
GaussDB 必须显式登记。目录 700、文件 600；Linux 的文件 sync 与父目录 sync 都成功后才能物理删除。
Windows 合成测试不证明 Linux 的断电持久性。数据库一致性备份和最新删除日志分别复制到服务器外私有存储，
记录清单及摘要；恢复必须取得截至恢复时刻的最新日志。日志仅保留到其影响的允许恢复备份全部到期，
不永久保留 owner 元数据，不允许使用过期备份恢复。

空会话行仅在运维显式登记 `ANONYMOUS_EMPTY_SESSION_RETENTION_DAYS` 正整数天数后按 registered_at 清理，
无默认值。仅清理无文档、无版本、无期限、无撤销/删除记录且非 legacy_pending 的行；未配置时不删除空行。
该窗口不改变资料期限；非法窗口使清理配置失败，不推测负责人已经同意清理。

Node.js instrumentation register 在非生产构建阶段显式启动进程单例；导入、构建及健康检查不连接数据库。
启动依次建立同一仓储、重放日志、开放 ready，并首轮清理，之后每小时非重叠运行；timer unref，可 stop
并等待当前操作。register 不等待数据 ready，也不抛出数据初始化错误，应用健康检查独立可用。
初始化/重放失败以安全错误拒绝 ready，文档请求返回 503；显式重新 start 可重试，已建立仓储不重复连接。
后续单轮清理失败不撤销其他有效会话的访问，就绪不代表过期资料可读；期限守卫持续拒绝到期访问。

### 私有维护命令

`scripts/generated/anonymous-retention.mjs` 为 Node 24 运维入口，不启动应用生命周期。
命令要求显式 DATABASE_PROVIDER；SQLite 还要求 SQLITE_PATH，避免误用开发默认库。
`inspect --output <file>` 独占创建 600 私有 JSON（禁止 public 路径），仅含 owner 哈希、解析时间后求得的
firstCreatedAt、documentCount、revisionCount、registrationState；不登记会话或清理，允许 schema 迁移。
`enroll --manifest <file> [--apply]` 输入完整 LegacyRetentionRegistration 数组；拒绝额外字段、重复 owner、
未知 owner、无通知、非法天数/日期及变化的既有登记。先在同一事务验证全批，再在显式 apply 时登记，
无 apply 不写会话。相同规范化登记重放不续期，即使窗口已结束仍可幂等验证；首次登记窗口必须在未来。
所有命令仅输出计数；错误为安全通用消息，非零退出，不输出正文、数据库错误或凭据。

`replay --journal <directory> --manifest <file> [--apply --offline-restored-database]` 针对已存在的恢复库。
manifest 格式为 `{ version: 1, target, files: [{ name, sha256 }] }`；SQLite target 为
`{ provider: "sqlite", path: <绝对规范路径> }`，GaussDB 为 `{ provider: "gaussdb", host, port, database }`。
target 必须与当前显式配置完全相同；files 必须完整覆盖日志目录（UUID.json、SHA-256 原始文件摘要），
禁止缺失、额外、链接、损坏文件、重复 id/owner期限及与数据库 deletion 记录冲突的内容。
默认只读校验日志、目标和删除记录并报告 owner 数；apply 还要求显式 offline-restored-database 声明。
该声明是运维停机确认，不能自动证明其他进程已停止：负责人必须停止全部应用、仅选择新恢复路径并保留现库。
全部校验通过后，经现有私有文件日志同步屏障，调用共享 replayDeletionIntents；失败不得启动服务或声称恢复成功。
manifest 由负责人对最新异地日志清单核验后生成并私下保管，摘要不能代替来源可信性与完整备份登记。

## 数据库运行

SQLite 文件由 `SQLITE_PATH` 指定，开发默认 `data/equilens.sqlite`。启用外键、WAL 和有限忙等待，
单进程内串行事务；数据库、WAL 和共享内存文件位于同一持久目录。仅运行一个应用实例。
首次访问在运行时建立版本化初始表，不在构建时连接数据库。未知 schema 版本必须拒绝启动数据访问。

GaussDB 配置使用独立的 `GAUSSDB_HOST/PORT/DATABASE/USER/PASSWORD`，默认校验 TLS 证书，
可通过 `GAUSSDB_CA_PATH` 提供 CA。禁止自动关闭证书校验。连接池有限，事务使用独立连接及条件更新，
不依赖 SERIALIZABLE、JSONB 或未验证的 PostgreSQL 特性。金额模型本次不新增。

## 部署与许可

应用按 AGPL-3.0-only 发布，保留 SuperDoc 等第三方声明。页面提供可访问的源码入口，部署记录对应准确提交。
用户已选择 AGPL 开源；仓库发布开关只在根许可、第三方声明和公开源码齐备后启用。
Zeabur 新项目使用同一 Next.js 单体镜像，单副本，SQLite 持久目录 `/data`，监听平台注入的端口，
绑定 `equilens.zeabur.app` 并验证 HTTPS。不得为此创建 GaussDB 实例或采购独立服务器。
数据库文件不进入 Git、镜像和构建上下文。备份使用 SQLite 一致性备份，不直接复制活跃 WAL 数据库单文件。
重部署后检查保存文件仍可下载；持久卷不等同于异地备份。

## 验证

DB-01：SQLite 保存后关闭并重开数据库，原件、版本和下载摘要一致。
DB-02：竞争保存仅一个成功；重复操作不生成额外版本；失败事务不留孤立版本。
DB-03：不同会话列表及资源、历史引用、复制来源隔离；缺失/跨站 Origin 的写操作拒绝。
DB-04：非法 provider、损坏 DOCX、超限输入、数据库故障显式失败，无静默降级或凭据泄漏。
DB-05：生产镜像以非 root 运行，挂载卷可写，重启后保存内容保持一致。
DB-06：Zeabur 域名 HTTPS 可达，文档新建、保存和下载闭环及隔离通过实际请求验证。
DB-07：GaussDB 真机验证连接、TLS、建表、事务、冲突、原件和版本往返；无实例时明确记录未运行。
DB-08：期限缺失/非法不接收新匿名资料；同会话固定到期且不续期；到期拒读写，离线/丢失 cookie 仍可按期清理；
到期后新会话可创建新资料且不能访问旧资料；存量迁移窗口内只读导出、窗口结束拒读，项目独立副本不受匿名清理影响；
恢复后不重新公开已到期资料。
