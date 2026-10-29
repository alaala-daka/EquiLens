# 第六轮共享任务板（C7 生命周期 / A5 平台验收）

基线 `alaaladaka/round5/business` @ `dd1eb16`；集成分支 `alaaladaka/round6/lifecycle`（W0 `ed7b585`，C7 `4ac0d61`，集成接线 `896cec3`）。
计划：[第六轮计划](../superpowers/plans/2026-10-29-round-six-plan.md)（独立审查 REVISE→三轮修订→CONFIRMED）。
本文件记录执行状态，不表示验收通过；状态只按实际命令/测试/证据更新。

## 工作包状态

| 包 | 主写者 | 范围 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| W0 | Lead | spec/01 §10.4—10.5、spec/04 0013/运行时/env/CLI、`.env.example`、计划 | 基线 | 已提交 `ed7b585` |
| C7 | Agent E | 接管 DELETE、每请求保留期撤销、删除记录/回收/日志/离线重放、按序删行覆盖、运行时与 CLI、删除状态入口 | W0 | 已提交 `4ac0d61`（C7+迁移定向 73/71 pass/2 skip；tsc 0；CLI e2e 记录） |
| A5 | Agent F | seed/备份集、双向删除重放演练、restore-verify、租约清理、卷式重启、迁移账本、两层容量、部署/运维文档 | W0 | 已提交 `aef2b9a`（双向演练/恢复/容量/浏览器基线均 exit 0，详见证据） |
| I1 | Lead | 0013 注册、运行时接线、CLI 打包、全量门禁、最终 A/C 收口 | C7、A5 | 0013/接线/CLI `896cec3`；门禁 `pnpm check` 0、`pnpm test` 958/956+2skip/0、`pnpm build` 0、smoke 通过；收口文档 `2026-10-29-ac-final-acceptance.md` 待随审查提交 |
| Review | 交叉审查 | 独立核对 C7/A5 实现与证据 | C7、A5 | 进行中 |

## C7 已落地要点

- 0013：`equilens_project_deletions`（requested/reclaiming/reclaimed/failed；requested_by 可 system；retention_until/cleared_at）+ `equilens_project_reclamations`（object_key 唯一，attempts/cleared_at）；无 FK/CHECK，条件更新一行。
- DELETE：同事务 `status='deleted'` + requested 记录（幂等、record-less reconcile）；随后写私有删除日志（一意图一文件、严格校验、temp+fsync+rename+逐级目录 fsync；Windows 目录 fsync EPERM 作为平台缺项记录，Linux 生产要求真实 fsync）；日志不可写不删对象、保持撤销。
- 每请求保留期撤销：authorization/access/repository/authorizeTaskExecution 派生检查，列表排除，注入时钟；合成项目不自动清扫。
- 对象清单从项目行重建（无 store list API；在途上传孤儿竞态记录为残余）；逐条 attempts、跨项目键拒绝、存储未配置 fail-closed；按序删行覆盖 C4/C5 + 运行时 B 线表（存在才删）；守护测试 bootstrap 运行时 schema 后枚举 sqlite_master。
- 离线重放：旧备份不复活（存在行置 deleted 并清理/补写记录；行不存在只写墓碑）；删除后备份 no-op；坏日志/重复/冲突拒绝。
- 运行时：start 不阻塞健康接口；后台链 ready 后 material→review/verification/knowledge→task runner；ready 门禁 503；单飞/unref/stop；清扫中 stop。
- CLI：`project-lifecycle inspect|reclaim|replay`（显式 DB、离线确认、脱敏、退出码），已加入构建与 `pnpm maintain:lifecycle`。
- `GET /api/projects/[id]/deletion`：requested_by/超管始终可读；其他当前管理员仅成员行未清理时可读；其余 404；只返回状态/attempts/时间。

## 未决与外部门槛

- 真实 GaussDB/OBS/MaaS/OCR、公网 HTTPS、CI 运行、Docker/Linux 容器与非 root/真实目录 fsync、ECS 外异地备份/24h 恢复目标：未验证，保持缺项。
- 领域签核、法律质量集、删除状态 UI、合成项目自动归档、在途上传孤儿竞态零残留：未交付或未宣称。
- AC-12/16/25/26 仅按本机实际恢复/容量证据说明支持范围；本机恢复耗时/损失窗口只作实测记录。
- 基线复核（第五轮 919 tests/918 pass/1 skip、浏览器 11 项）在 A5 证据中记录；本轮新执行结果单独陈述。
