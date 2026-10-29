# C2a 材料 HTTP 与异步提交

2026-10-29，Windows、Node24、本地SQLite及合成私有存储。Demo技术范围；不代表真实OBS、GaussDB或完整业务AC通过。

新增项目材料列表/上传/详情、版本下载、快照/来源读取、重解析路由。写请求同源校验，所有服务读写重验身份与项目权限；响应private no-store。multipart在formData前检查声明大小并流式读取有界请求，真实字节再按20MiB限制。文件签名决定格式，不信扩展名和Content-Type。

HTTP使用单独QueuedMaterialService，不调用旧同步registerMaterial或parseMaterial。DOCX预检经已有受限校验子进程；完整材料解析由C2b负责。提交返回真实持久parseTaskId，不返回coverage或伪造快照。材料版本先保存，解析任务固定版本摘要，任务提交前再次授权；重复摘要复用版本及任务。重解析显式新任务，保留历史版本和快照。下载重新计算字节摘要核对版本记录。

生产未注册material-parse执行器时503，先于对象写入。真实存储未验证，仍为createUnavailableObjectStore；没有合成替代生产。新0008数组增加materials.parse_task_id，不改0006。C2b将接执行器、受限完整解析及恢复生命周期。

实际验证：

- RED：queued.test.ts首次运行exit1，缺queued实现模块。
- `pnpm exec tsx --test src/server/materials/*.test.ts src/server/storage/*.test.ts`：exit0，29/29通过。新增覆盖生产者不可用不写对象、真实SQLite持久任务/重复摘要/显式重解析、只读上传与重解析拒绝、退出后撤权、实际校验子进程非法ZIP拒绝、20MiB上限、HTTP401/同源/大小/multipart/私有下载。
- `pnpm check`：exit0，ESLint、路由类型、TypeScript通过。
- `git diff --check -- src/server/materials src/app/api/projects`：exit0。

未执行：生产HTTP实际服务器、浏览器、真实OBS、GaussDB、完整PDF子进程处理、任务执行后快照新revision联验及容器。旧同步材料API仅保留既有测试兼容，不被新增HTTP调用。解析任务恢复和生命周期显式接线由C2b完成后再验，不提前宣称完整上传至解析成功闭环。

独立审查两项修复：列表及详情按项目关联持久任务，返回parseTaskId和真实parseState，coverage仍独立来自快照。上传准入在单应用内串行，0008增加(project_id,sha256)数据库唯一索引提供持久原子防线，防止不同准入路径重复提交版本；未修改0006。

修复验证：真实SQLite Promise.all同时上传同字节返回同一版本/任务且材料仅一项；HTTP刷新列表与详情分别断言queued/running/failed的实际数据库任务状态。材料/存储测试29/29 exit0，pnpm check exit0，定向diff-check exit0。未运行多实例/GaussDB，单实例约束不变。
`nfixround2：移除无界串行等待链，最多4个在途请求及40MiB；重复进行中及时503，成功后重试复用版本与任务。存储put响应30秒超时；底层操作未结束时保留准入额度直到settle，防止超时释放额度造成缓冲区无限增长。新增阻塞4请求及20超额请求即时拒绝测试。定向materials/queued测试12/12 exit0，pnpm check exit0。初次回归发现同步参数异常不返回Promise，已恢复async方法并回归通过。
fixround3：每个upload独立追踪其put，移除全局pendingStores依赖，成功请求不等待其他请求。新增1挂起put期间连续10次其他摘要成功上传回归，queued测试3/3 exit0；pnpm check exit0。
