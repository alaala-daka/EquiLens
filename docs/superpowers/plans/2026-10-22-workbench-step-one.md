# 工作台完善：步骤一实施计划

> **For agentic workers:** 按复选框逐项执行；用户明确授权委派时使用 `subagent-driven-development`，否则在当前会话顺序执行。仅有计划不构成实施、提交、发布或部署的指令。

**Goal:** 完成文档列表、标题检索、真实加载/错误/取消状态和匿名到期交互，通过 UI-01—UI-06。

**Architecture:** 保持 Next.js 单体及现有 DOCX 编辑器。列表展示、列表请求状态和文档操作分别放在小型专用模块，工作台负责组合；匿名期限由配套服务计划实现，界面只读取服务端状态及期限，不自行授权或推算有效期。

**Tech Stack:** Node.js 24、pnpm 11.6.0、Next.js 16.4.2、React 19.3.0、TypeScript、现有 shadcn/ui Radix / Nova、Node.js test runner + tsx。

## Global Constraints

- 契约入口：[规格索引](../../../spec/README.md)；本计划不替代 `spec/`，不把计划中的接口说明变成第二份业务契约。
- 范围：[工作台规格 §3](../../../spec/02-workbench-ui.md#3-步骤一工作台完善)、§6—§7，以及[数据库规格](../../../spec/04-database-deployment.md)的 DB-08。
- 使用 Node.js 24 和 pnpm 11.6.0；提交 `pnpm-lock.yaml`，不增加 npm/yarn 锁文件。
- “顶层保持‘文档 / 规范库’两个页签。”不增加侧栏、四业务导航、项目入口或统计图表。
- “本步不增加删除、历史版本浏览或规范管理入口。”不重做 Word 工具栏，不开放 Agent 发送。
- “清空查询恢复完整授权列表；步骤一不检索正文、不调用模型、不增加批量操作或文件夹。”
- “更新时间取服务端 `updatedAt`，按 Asia/Shanghai 显示到分钟；默认降序，同一时刻按 ID 升序稳定排列。”
- 沿用官方组件与系统字体；不增加组件库、数据表框架、状态库、测试渲染器或远程字体。
- 私有文件不进入公共目录、共享缓存、URL 或日志；匿名会话不是账号/项目授权，不计 AC-01 通过。
- 只使用合成或明确授权样本；测试中的保留天数只是夹具值，不是生产默认值。
- 当前工作区已有规格和审查记录修改。保留它们；未来提交只暂存当前任务涉及的明确路径，不使用 `git add .`。

---

## 交付拆分与执行顺序

步骤一包含两个可独立联调、最终一起验收的工作包：

1. 本文件任务 1—2：列表、查询与请求状态，依托现有 API 开发。
2. [匿名资料保留配套计划](2026-10-22-anonymous-retention-step-one.md) S1 确定共享类型后执行本文件任务 3；再完成配套 S2—S3 的期限和会话 API。
3. 本文件任务 4 接入已通过测试的期限与新会话服务；配套 S4—S6 完成清理、迁移与容器检查。
4. 本文件任务 5：运行完整回归，记录 UI-01—UI-06；DB-08 不通过时不能宣布步骤一完整交付。

不等待全部视觉和人工 Word 回归才准备后续合同纵向联调；本计划完成条件不等于步骤二或业务 AC 通过。

## 代码基线与改动地图

当前 `workbench.tsx` 只有文档标题列；列表请求失败后仍可能呈现空状态，刷新响应没有代次保护；
取消只阻止部分打开动作，操作统一显示“正在打开文档”。`client.ts` 未传递取消信号且将所有 409 都解释为保存冲突。
期限与清理尚未实现，不能用页面常量模拟到期日。

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/lib/documents/list-view.ts`、`list-view.test.ts` | 新建 | 标题过滤、稳定排序、创建方式和北京时间显示 |
| `src/components/document-list.tsx` | 新建 | 官方 Table 结构、标题打开入口与窄屏元数据 |
| `src/lib/documents/list-store.ts`、`list-store.test.ts` | 新建 | 首次加载、刷新失败、请求代次和列表更新 |
| `src/lib/documents/operations.ts`、`operations.test.ts` | 新建 | 新建/导入/打开、重复点击、取消与迟到响应 |
| `src/components/workbench.tsx` | 修改 | 组合状态、页签、检索和现有编辑器 |
| `src/lib/documents/client.ts` | 修改 | 取消信号；期限 API 和错误码由配套计划提供 |
| `src/components/document-session-dialog.tsx` | 新建 | 官方 Alert Dialog 的到期确认和重新开始操作 |
| `src/components/document-editor.tsx` | 最小修改 | 只传递会话失效事件；不实施步骤二布局/保存反馈改造 |
| `README.md`、`DEVELOPMENT.md` | 修改 | 已实现状态和实际操作；不预写测试结果 |
| `docs/reviews/2026-10-22-workbench-step-one-validation.md` | 执行时新建 | 输入、环境、原始检查结果、截图及缺口 |

## 任务 1：列表、标题检索与元数据

**Files:** 新建 `src/lib/documents/list-view.ts`、`list-view.test.ts`、`src/components/document-list.tsx`；修改 `src/components/workbench.tsx`。

**Interfaces:**

```ts
import type { DocumentRecord } from "./types"

export function selectDocuments(documents: readonly DocumentRecord[], query: string): DocumentRecord[]
export function formatDocumentUpdatedAt(value: string): string
export declare const documentSourceLabel: Record<DocumentRecord["source"], string>
```

组件使用如下 props，不承担网络请求、权限判断或 Word 生命周期：

```ts
type DocumentListProps = {
  documents: readonly DocumentRecord[]
  busy: boolean
  onOpen: (id: string) => void
}
```

- [ ] **1.1 读取官方来源并记录适配理由。**重新查看 [Blocks](https://ui.shadcn.com/blocks) 的 `dashboard-01` 页面源码，以及 [Table](https://ui.shadcn.com/docs/components/radix/table)、[Input](https://ui.shadcn.com/docs/components/radix/input)、[Button](https://ui.shadcn.com/docs/components/radix/button)、[Empty](https://ui.shadcn.com/docs/components/radix/empty) 示例。保留工作台规格已选的组件组合；窄屏元数据换行是必要响应式适配。
- [ ] **1.2 写有确定预期的检索/排序测试。**在 `list-view.test.ts` 定义完整夹具：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { DocumentRecord } from "./types"
import { selectDocuments, formatDocumentUpdatedAt } from "./list-view"

const record = (id: string, title: string, updatedAt: string): DocumentRecord => ({
  id, title, updatedAt, createdAt: updatedAt,
  source: "authored", prompt: "", currentRevision: `${id}-revision`,
})

test("UI-02/03: trim, case-insensitive title search and stable instant order", () => {
  const rows = [
    record("b", "安装合同 Alpha", "2026-10-22T08:00:00Z"),
    record("a", "安装合同 ALPHA", "2026-10-22T16:00:00+08:00"),
    record("c", "补充协议", "2026-10-22T09:00:00Z"),
  ]
  rows[2].prompt = "安装合同 alpha"
  assert.deepEqual(selectDocuments(rows, " alpha ").map(row => row.id), ["a", "b"])
  assert.deepEqual(selectDocuments(rows, "安装").map(row => row.id), ["a", "b"])
  assert.deepEqual(selectDocuments(rows, " ").map(row => row.id), ["c", "a", "b"])
  assert.deepEqual(selectDocuments(rows, "不存在"), [])
  assert.deepEqual(rows.map(row => row.id), ["b", "a", "c"])
})

test("UI-02: show the saved instant in Asia/Shanghai, including day rollover", () => {
  assert.equal(formatDocumentUpdatedAt("2026-10-22T16:05:00Z"), "2026-10-23 00:05")
})
```

- [ ] **1.3 运行红灯检查。**执行 `pnpm exec tsx --test src/lib/documents/list-view.test.ts`，确认缺少目标模块或行为不满足导致失败，不把环境/安装错误当作预期红灯。
- [ ] **1.4 实现纯展示函数。**以下算法不修改传入数组、不读取正文或会话内容：

```ts
export const documentSourceLabel = { authored: "新建", imported: "导入", copy: "副本" }

export function selectDocuments(documents: readonly DocumentRecord[], query: string) {
  const needle = query.trim().toLowerCase()
  return documents.filter(document => document.title.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const updatedAtFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})

export function formatDocumentUpdatedAt(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "时间不可用"
  const parts = Object.fromEntries(updatedAtFormatter.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
```

- [ ] **1.5 组合列表与查询。**`workbench.tsx` 新增仅存在于该组件实例的 `query` 状态；用 `selectDocuments(documents, query)` 取得可见记录。输入有可访问名称“搜索文档”，清空按钮恢复授权列表。未过滤数组为空显示“暂无文档”；原数组非空且过滤为空显示“未找到文档”和“清空搜索”。
- [ ] **1.6 沿用官方表格实现三列。**名称用原生可聚焦 Button `link` 变体调用 `onOpen(document.id)`；创建方式来自 `source`，时间来自 `updatedAt`。桌面显示三列；小于 768px 将后两列隐藏并在名称下方显示相同元数据。标题完整换行，若使用截断必须另外提供键盘可用的全文查看。使用 `table-fixed` 仅为防止超长文件名撑破容器，记录该适配，不添加任意宽度和自定义配色。
- [ ] **1.7 验证并保存任务边界。**运行该测试及 `pnpm check`；浏览器验证同名不同 ID 都能打开。只提交本任务四个源码路径，建议提交信息 `feat: improve workbench document list`。

## 任务 2：首次读取、刷新失败与请求竞争

**Files:** 新建 `src/lib/documents/list-store.ts`、`list-store.test.ts`；修改 `src/lib/documents/client.ts`、`src/components/workbench.tsx`。

**Consumes:** `DocumentRecord`、任务 1 的 `selectDocuments`，以及 `listDocuments(signal?: AbortSignal): Promise<DocumentRecord[]>`。

**Produces:** 下列专用状态仓库；构造时不发请求、不访问浏览器，不创建通用状态框架：

```ts
export type DocumentListSnapshot =
  | { kind: "loading"; documents: readonly DocumentRecord[]; error: null; refreshing: false }
  | { kind: "initial-error"; documents: readonly DocumentRecord[]; error: string; refreshing: false }
  | { kind: "ready"; documents: readonly DocumentRecord[]; error: string | null; refreshing: boolean }

export type DocumentListStore = {
  getSnapshot(): DocumentListSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  upsert(document: DocumentRecord): void
  cancel(): void
  reset(): void
}

export function createDocumentListStore(
  fetchDocuments: (signal: AbortSignal) => Promise<DocumentRecord[]>,
): DocumentListStore
```

- [ ] **2.1 写刷新失败和过期响应测试。**`list-store.test.ts` 使用以下独立请求夹具；补齐标准 `node:test` / assert 导入和目标函数导入：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { DocumentRecord } from "./types"
import { createDocumentListStore } from "./list-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const document: DocumentRecord = {
  id: "synthetic-doc", title: "合同", source: "authored", prompt: "",
  createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", currentRevision: "r1",
}

test("UI-04: refresh error retains the last successful list", async () => {
  let fail = false
  const store = createDocumentListStore(async () => {
    if (fail) throw new Error("合成网络失败")
    return [document]
  })
  await store.refresh()
  fail = true
  await store.refresh()
  assert.equal(store.getSnapshot().kind, "ready")
  assert.equal(store.getSnapshot().documents[0].id, document.id)
  assert.equal(store.getSnapshot().error, "合成网络失败")
})

test("UI-04/05: refresh response cannot erase a newly saved revision", async () => {
  const late = deferred<DocumentRecord[]>()
  let calls = 0
  const store = createDocumentListStore(() => ++calls === 1 ? Promise.resolve([document]) : late.promise)
  await store.refresh()
  const pending = store.refresh()
  store.upsert({ ...document, title: "已保存修订", currentRevision: "r2" })
  late.resolve([document])
  await pending
  assert.equal(store.getSnapshot().documents[0].currentRevision, "r2")
})
```

- [ ] **2.2 运行红灯检查。**执行 `pnpm exec tsx --test src/lib/documents/list-store.test.ts`。
- [ ] **2.3 实现状态转换。**仓库维护递增 `generation`、一个 `AbortController` 和稳定 snapshot；`subscribe` 返回解除函数。`refresh` 在已有 ready 状态保留列表并设置 `refreshing`，首次读取才使用 loading；只有同代响应能够提交。首次失败进入 initial-error，刷新失败保留 ready 数据并记录错误。成功提交前重新检查请求代次。

```ts
export function createDocumentListStore(
  fetchDocuments: (signal: AbortSignal) => Promise<DocumentRecord[]>,
): DocumentListStore {
  let snapshot: DocumentListSnapshot = { kind: "loading", documents: [], error: null, refreshing: false }
  let generation = 0
  let controller: AbortController | null = null
  const listeners = new Set<() => void>()
  const publish = (value: DocumentListSnapshot) => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  const cancelPending = () => { generation += 1; controller?.abort(); controller = null }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async refresh() {
      cancelPending()
      const captured = generation
      const pending = new AbortController()
      controller = pending
      publish(snapshot.kind === "ready" ? { ...snapshot, error: null, refreshing: true }
        : { kind: "loading", documents: [], error: null, refreshing: false })
      try {
        const documents = await fetchDocuments(pending.signal)
        if (captured !== generation || pending.signal.aborted) return
        publish({ kind: "ready", documents, error: null, refreshing: false })
      } catch (failure) {
        if (captured !== generation || pending.signal.aborted) return
        const error = failure instanceof Error ? failure.message : "读取文档失败，请重试。"
        publish(snapshot.kind === "ready" ? { ...snapshot, error, refreshing: false }
          : { kind: "initial-error", documents: [], error, refreshing: false })
      } finally { if (controller === pending) controller = null }
    },
    upsert(document) {
      cancelPending()
      if (snapshot.kind !== "ready") return
      publish({ kind: "ready", documents: [document, ...snapshot.documents.filter(row => row.id !== document.id)], error: null, refreshing: false })
    },
    cancel() { cancelPending(); if (snapshot.kind === "ready") publish({ ...snapshot, refreshing: false }) },
    reset() { cancelPending(); publish({ kind: "loading", documents: [], error: null, refreshing: false }) },
  }
}
```

- [ ] **2.4 连接客户端和组件。**`request`、`listDocuments` 增加可选 `signal` 并传给 fetch；不将 AbortError 转成页面错误。工作台以 `useState(() => createDocumentListStore(listDocuments))` 创建实例、`useSyncExternalStore` 订阅；effect 执行 refresh 并注册 focus 刷新，cleanup 取消请求和解绑。实例不能因每次输入重建；cleanup 后可再次 refresh，兼容 Strict Mode 的 setup/cleanup/setup。
- [ ] **2.5 显示真实状态。**loading 显示“正在读取文档”；initial-error 显示错误和“重试”，不渲染空状态。ready 刷新失败保留列表并给出重试。首次列表成功读取前禁用新建/导入；后台刷新不重复播报整份列表。保留“规范库 / 暂无规范”，没有上传或发布入口。
- [ ] **2.6 增加两个明确反例。**初次 fetch 抛错后断言 kind 为 initial-error，重试成功后 kind 为 ready；创建两个 deferred 请求，第二个先成功、第一后失败，断言最终仍是第二个列表且没有旧错误。测试沿用本任务已定义的 `deferred` 与 `document`。
- [ ] **2.7 验证并保存任务边界。**运行任务 1、2 的测试和 `pnpm check`；浏览器离线复现首次失败/刷新失败两条路径。建议提交 `fix: preserve document list across refresh failures`，仅暂存本任务涉及路径。

## 任务 3：新建、导入、打开与取消

**Files:** 新建 `src/lib/documents/operations.ts`、`operations.test.ts`；修改 `src/lib/documents/client.ts`、`src/components/workbench.tsx`。

**Consumes:** 任务 2 的 `DocumentListStore`，现有 `blankDocx`、`validateDocx`、`OpenDocument`。

**Produces:** `createDocumentOperations(deps)`，返回 `create(file?: File): Promise<void>`、`open(id: string): Promise<void>`、`cancel(): void`、`getSnapshot()`、`subscribe(listener)`。

```ts
type DocumentOperation = "creating" | "importing" | "opening"
type OperationSnapshot = { operation: DocumentOperation | null; error: Error | null }
export type OperationDependencies = {
  list: DocumentListStore
  blank: () => Blob
  validate: (blob: Blob, signal: AbortSignal) => Promise<unknown>
  create: (blob: Blob, title: string, source: "authored" | "imported", fileName: string | undefined,
    signal: AbortSignal) => Promise<OpenDocument | null>
  open: (id: string, signal: AbortSignal) => Promise<OpenDocument>
  onOpened: (opened: OpenDocument) => void
}
```

`create` 依赖返回 null 表示用户取消期限确认，不是保存成功。任务 4 只替换这一适配器，不重写操作状态机。

- [ ] **3.1 写取消后迟到响应与重复提交测试。**`operations.test.ts` 使用 `blankDocx` 构造 Blob，构造包含 `document` 和 `revision` 的完整 `OpenDocument` 夹具；其中摘要使用 `createHash("sha256")` 对 Blob 字节计算，不把测试夹具送往云服务。

```ts
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { blankDocx } from "./docx"
import { EDITOR_VERSION, type OpenDocument } from "./types"
import { createDocumentListStore } from "./list-store"
import { createDocumentOperations } from "./operations"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function sample(id: string): Promise<OpenDocument> {
  const blob = blankDocx()
  const at = "2026-10-22T00:00:00Z"
  return {
    document: { id, title: id, source: "authored", prompt: "", createdAt: at, updatedAt: at, currentRevision: `${id}-r1` },
    revision: { id: `${id}-r1`, documentId: id, parentId: null, blob,
      hash: createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex"),
      createdAt: at, editorVersion: EDITOR_VERSION, templateVersion: "blank-v1" },
  }
}

test("UI-05: cancel after submission cannot open a late created document", async () => {
  const first = await sample("first")
  const second = await sample("second")
  const late = deferred<OpenDocument>()
  const submitted = deferred<void>()
  const seen: string[] = []
  const list = createDocumentListStore(async () => [second.document])
  await list.refresh()
  const operations = createDocumentOperations({
    list, blank: blankDocx, validate: async () => {},
    create: async () => { submitted.resolve(); return late.promise },
    open: async () => second, onOpened: value => { seen.push(value.document.id) },
  })
  const pending = operations.create()
  await submitted.promise
  operations.cancel()
  await operations.open(second.document.id)
  late.resolve(first)
  await pending
  assert.deepEqual(seen, [second.document.id])
  assert.equal(operations.getSnapshot().operation, null)
})
```

- [ ] **3.2 运行红灯检查。**执行 `pnpm exec tsx --test src/lib/documents/operations.test.ts`。
- [ ] **3.3 实现操作屏障。**factory 内使用独立的 active 操作对象，不让旧 finally 清空新操作：

```ts
export function createDocumentOperations(deps: OperationDependencies) {
  let active: { controller: AbortController } | null = null
  let snapshot: OperationSnapshot = { operation: null, error: null }
  const listeners = new Set<() => void>()
  const publish = (value: OperationSnapshot) => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  async function run(kind: DocumentOperation, work: (signal: AbortSignal) => Promise<OpenDocument | null>) {
    if (active) return
    const current = { controller: new AbortController() }
    active = current
    deps.list.cancel()
    publish({ operation: kind, error: null })
    try {
      const opened = await work(current.controller.signal)
      if (active !== current || current.controller.signal.aborted || !opened) return
      if (kind !== "opening") deps.list.upsert(opened.document)
      deps.onOpened(opened)
    } catch (failure) {
      if (active === current && !current.controller.signal.aborted) {
        publish({ operation: kind, error: failure instanceof Error ? failure : new Error("文档操作失败，请重试。") })
      }
    } finally {
      if (active === current) { active = null; publish({ operation: null, error: snapshot.error }) }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    create(file?: File) {
      return run(file ? "importing" : "creating", async signal => {
        if (file && !/\.docx$/i.test(file.name)) throw new Error("请选择 .docx 格式的 Word 文档。")
        const blob = file ?? deps.blank()
        await deps.validate(blob, signal)
        signal.throwIfAborted()
        return deps.create(blob, file ? file.name.replace(/\.docx$/i, "") : "未命名文档",
          file ? "imported" : "authored", file?.name, signal)
      })
    },
    open(id: string) {
      return run("opening", async signal => {
        const opened = await deps.open(id, signal)
        signal.throwIfAborted()
        await deps.validate(opened.revision.blob, signal)
        signal.throwIfAborted()
        return opened
      })
    },
    cancel() {
      const prior = active
      active = null
      prior?.controller.abort()
      publish({ operation: null, error: null })
    },
  }
}
```

factory 返回的 `create` 用 `run` 包裹：验证 `.docx` 扩展名，取得 `file ?? deps.blank()`，执行 `deps.validate`，再次 `signal.throwIfAborted()`，然后调用 `deps.create`；标题按现有文件名去扩展名规则生成。`open` 用 `run` 包裹读取、校验和取消检查，不用旧读取响应覆盖列表元数据。`cancel` 先将 active 置空，再 abort 原 controller，并发布空操作、空错误；没有触发服务端删除或回滚。

- [ ] **3.4 为真实请求传递取消。**`openDocument(id, signal?)` 将 signal 交给 request；`createDocument` 保持原六个参数，新增第七个 `options?: { signal?: AbortSignal; retentionConsent?: RetentionConsent }`。编码前后与 fetch 前检查 signal；`RetentionConsent` 由配套计划的共享类型提供。既有 Word 另存调用保持兼容，但启用期限后也必须走已确认会话上下文，不能绕开期限守卫。
- [ ] **3.5 绑定页面操作。**新建、导入、列表打开、空状态新建都调用同一 operations 实例。文案分别为“正在新建文档 / 正在导入文档 / 正在打开文档”；busy 时禁止重复操作。取消后保留列表与 query；已提交创建可能已经保存，用户重新读取列表时仍可见，不显示“已撤销上传”。组件清理取消当前操作，切换编辑器仍用现有 `DocumentEditor`。
- [ ] **3.6 增加独立行为用例。**沿用本任务 `sample/deferred`：同一 pending create 连点两次，create 适配器计数必须为 1；validate 抛错时计数为 0；create 返回 null 时 `onOpened` 计数为 0；旧请求取消后抛错不能改写新 open 的状态；取消创建后再次 refresh 能看到服务端已保存文档。每个测试都断言当前列表或打开 ID，而不只断言内部方法被调用。
- [ ] **3.7 验证并保存任务边界。**运行 `pnpm exec tsx --test src/lib/documents/list-store.test.ts src/lib/documents/operations.test.ts` 和 `pnpm check`。建议提交 `fix: isolate workbench document operations`，仅暂存本任务涉及路径。

## 任务 4：接入实际期限、迁移窗口与新会话

**Files:** 新建 `src/components/document-session-dialog.tsx`；修改 `src/components/workbench.tsx`、`src/components/document-list.tsx`、`src/lib/documents/client.ts`、`src/components/document-editor.tsx`。

**前置条件：**配套计划任务 S1—S3 的共享类型、服务端守卫和会话 API 已通过测试；清理与恢复验收仍是最终交付条件。

**Consumes:**

```ts
import type { AnonymousSessionView, RetentionConsent } from "@/lib/documents/session-types"
import { getDocumentSession, restartDocumentSession, setDocumentContext, DocumentSessionError } from "@/lib/documents/client"

export type RetentionConfirmationRequest = {
  consent: RetentionConsent
  signal: AbortSignal
}
type DocumentSessionDialogProps = {
  request: RetentionConfirmationRequest | null
  onDecision: (accepted: boolean) => void
}
```

`getDocumentSession(signal?)` 和 `restartDocumentSession(signal?)` 均返回 `Promise<AnonymousSessionView>`；完整线协议和错误码见配套计划 S1。

- [ ] **4.1 验证服务不是占位。**用隔离测试数据库检查 GET `/api/document-session` 返回服务端到期信息；缺配置不能新建；到期响应不能携带旧文档字节。没有真实 API 时保留任务未完成，不能在页面硬编码保留天数或成功状态。
- [ ] **4.2 实现期限确认对话框。**沿用官方 Alert Dialog；标题“确认文档保留期限”，正文只显示服务端给出的到期日及“到期后将无法访问，请及时下载需要保留的文档。”，按钮“取消 / 确认并继续”。用户取消、关闭或 signal abort 都结算为 false，不发创建请求；关闭后恢复原按钮焦点。
- [ ] **4.3 将确认接入任务 3 的 create 适配器。**每次新建/导入先读取会话，再等待用户确认，最后提交服务端给出的 consent；会话状态、配置或到期日变化时显示实际错误并由用户重新确认，不自动重发创建：

```ts
const createWithConsent: OperationDependencies["create"] = async (blob, title, source, fileName, signal) => {
  const view = await getDocumentSession(signal)
  signal.throwIfAborted()
  if (!view.canCreate || !view.confirmation) throw new Error(view.issue?.message ?? "当前无法新建文档。")
  const accepted = await requestConfirmation({ consent: view.confirmation, signal })
  signal.throwIfAborted()
  if (!accepted) return null
  return createDocument(blob, title, source, fileName, "", undefined, {
    signal, retentionConsent: view.confirmation,
  })
}
```

`requestConfirmation(request): Promise<boolean>` 在工作台中管理一个 resolver 和一个对话框请求；重复调用由 operations 的 busy 屏障阻止。decision、abort 和 cleanup 都仅结算一次，清除 resolver、解除 abort 监听，不留下挂起 Promise。
若读取到的 contextId 与当前工作区不同，先按会话切换清理旧视图并终止本次创建，不在旧编辑器里继续使用新上下文。

- [ ] **4.4 正确呈现服务能力。**读取会话能力并确认仍为当前代次后，先 `setDocumentContext(view.contextId)` 再读取列表；不能读取时显示真实错误/到期状态。首屏与 focus 的固定次序是：读取会话 → `setDocumentContext` → 触发列表 refresh；会话未就绪时列表保持加载状态，不发送缺上下文的文档请求，任务 2 的首次 refresh 在本任务改为会话就绪后执行。`active` 且期限配置缺失时，既有合法读取不被空列表替代，但禁用服务端声明不可用的新建/导入。`legacy_export` 只允许读取已保存版本并下载同一份字节，不挂载可编辑 Word 引擎、不序列化新内容。该窗口下 `document-list` 通过新增的可选 `onDownload`（或等价动作）呈现“下载 Word”，`onOpen` 默认隐藏；props 变更与偏离记录在本任务说明。
- [ ] **4.5 接入失效与重新开始。**工作台在 focus、服务端会话错误以及服务端 expiresAt 对应的本地提醒时重新读取会话；浏览器时间只触发核对，不作权限判断。已到期则撤下不可访问的文档/编辑器，不允许通过“另存”导出当前缓冲绕过期限；保留必要的未保存告知。`DocumentEditor` 新增可选 `onSessionUnavailable(error: DocumentSessionError): void`，仅向父组件转交会话失效/切换错误，其余编辑行为不变。
- [ ] **4.6 实现“开始新会话”。**普通到期或迁移窗口结束后显示该操作；仅服务端 canRestart 为 true 时可确认，配置错误按实际原因呈现。先用 Alert Dialog 明确旧资料不会迁入新会话；确认后 POST action=`restart`。仅在服务端成功后执行 `operations.cancel()`、`list.reset()`、清空 query/打开文档/待选文件/确认 resolver，设置返回的新 contextId，再读取新会话与空列表。失败仍保留到期状态和重试操作，不展示空列表成功；迟到的旧会话响应不得回填。
- [ ] **4.7 完成浏览器检查。**取消期限确认时网络面板没有文档 POST；确认后文档可保存/重开；到期状态无新建/保存/复制/下载；迁移窗口只读下载且摘要相同；新会话可以新建但旧 ID 不可访问。网络故障分别测试读取期限、创建和 restart 失败。保留实际到期日与请求结果证据，不截图 cookie。
- [ ] **4.8 验证并保存任务边界。**运行所有文档/会话单元与 HTTP 测试、`pnpm check`。建议提交 `feat: connect workbench retention controls`，仅暂存本任务路径；配套服务端改动独立提交，不混入步骤二。

## 任务 5：第一步整体验收与运行说明

**Files:** 修改 `README.md`、`DEVELOPMENT.md`；执行时新建 `docs/reviews/2026-10-22-workbench-step-one-validation.md`。配套计划负责环境配置、镜像运行参数及 DB-08。

**Consumes:** 任务 1—4 和配套计划已完成的实际功能；产出是验证记录，不是新业务能力。

- [ ] **5.1 先检查环境，再独立安装锁定依赖。**核对 Node.js 24 与 pnpm 11.6.0，执行 `pnpm install --frozen-lockfile`。首次依赖安装完成前不并行启动多个 pnpm 检查，避免共同写入依赖目录；安装失败按环境权限流程处理，不换 registry 或跳过供应链检查。
- [ ] **5.2 运行工程回归。**依次执行：

```powershell
pnpm check
pnpm test
pnpm build
git diff --check
```

代码/类型失败先修复再扩大检查；不为组件静态样式添加镜像实现的单元测试。所有红灯/绿灯及生产构建输出由执行时实际记录。

- [ ] **5.3 使用专用合成数据库启动。**以下数值只用于本地验证，不提供生产期限默认值：

```powershell
$env:SQLITE_PATH = 'data/workbench-step-one-validation.sqlite'
$env:ANONYMOUS_DATA_RETENTION_DAYS = '2'
$env:ANONYMOUS_DELETION_JOURNAL_DIR = 'data/workbench-step-one-validation-journal'
$env:PORT = '18081'
$env:HOSTNAME = '127.0.0.1'
$env:APP_ORIGIN = 'http://127.0.0.1:18081'
pnpm start
```

在另一终端执行 `pnpm smoke http://127.0.0.1:18081`。启动前确认该端口空闲，不终止用户已有服务。不得清空真实 `data/equilens.sqlite`，不得修改系统时间测试到期；时间边界由配套计划的可注入时钟测试。UI-05 的到期、迁移和缺配置状态需要预置：在专用合成库上将 `expires_at` 改写到过去时刻，或以合成通知与日期对该库执行配套 S5 的 `enroll --apply` 生成迁移窗口，重启应用后再测；缺配置另起一个不设 `ANONYMOUS_DATA_RETENTION_DAYS` 的实例，验证 `/healthz` 仍 200 且创建返回 503。预置方式与实际状态一并记录；无法安全预置的场景按未执行记录，由配套 S3/S5 的可注入时钟测试承载，不得记为 UI 通过。

- [ ] **5.4 逐项记录以下浏览器场景。**使用隔离 Edge 或已验证的浏览器工具；不假定 Python/Playwright 命令必然可用，不为此安装新组件库。网络故障可用浏览器离线/节流；响应竞争由确定性单元测试补证。

| 验收 | 输入/操作 | 必须观察到的结果 |
| --- | --- | --- |
| UI-01 | 新匿名会话，切换两个顶层页签 | 默认文档；无虚构记录；规范库仅“暂无规范” |
| UI-02 | 两个同名文件、不同更新时间、跨北京时间日期文件、超长标题 | 三列正确；按原始时刻和 ID 稳定排序；两个文件独立打开；长标题有键盘可用的完整查看 |
| UI-03 | 中文片段、前后空白、不同大小写英文、无匹配、清空查询 | 只检索标题；无匹配和资源为空状态不同；返回列表保留 query |
| UI-04 | 首次离线、恢复重试、已有列表后离线刷新 | 首次失败不出现“暂无文档”；刷新失败保留数据 |
| UI-05 | 连点、校验中取消、提交后取消、坏 DOCX、缺配置、到期、迁移、重开会话（状态预置见 5.3） | 无重复操作和迟到自动打开；真实错误；已保存可重新查询；期限与新会话符合 DB-08 |
| UI-06 | 1440×900、1024×768、390×844、200% 缩放及纯键盘 | 操作可达；长标题能完整读取；焦点可见、对话框关闭恢复焦点；无应用外壳横向溢出 |

- [ ] **5.5 回归已有 Word 边界。**合成 DOCX 新建/导入、标题及正文编辑、保存重开、导出；比对原件和已保存版本摘要。Agent 输入隔离且无法发送。未执行 Microsoft Word 人工核对时明确注明，不将 UI 回归冒充全部 WD 通过。
- [ ] **5.6 核对容器与恢复证据。**采用配套计划 S6 的隔离卷和运行变量，验证新建/保存、容器重启、新会话隔离及 DB-08 删除重放；PR 仍只构建验证，不更改 GHCR 发布规则。GaussDB 未实测须单独列出，不用 SQLite 结果替代。
- [ ] **5.7 更新说明。**只在功能和配置实际生效后移除 README 的对应“待实现契约”说明；保留未实现业务和云服务的真实状态。记录源码版本、环境、视口、合成输入、实际命令、通过/失败/未执行项；截图放入本次验证记录引用的审查资料目录，不包含凭据和私有内容。
- [ ] **5.8 完成任务提交。**只暂存本次说明和验证记录，建议 `docs: record workbench step one validation`。不推送、发布镜像或部署；这些不属于本计划的撰写请求。

## 完成闸门与交接

- [ ] UI-01—UI-06 均有可复现的实际证据，共用 §6 检查完成。
- [ ] 文档服务 DB-01—DB-04 回归；配套计划 DB-08 完成，含迁移及删除重放。
- [ ] `pnpm check`、`pnpm test`、`pnpm build`、运行冒烟与 `git diff --check` 通过；容器相关检查据实记录。
- [ ] 没有新增项目/账号、PDF/OCR、业务分析、Agent 发送、删除按钮或历史版本 UI。
- [ ] 原 AC-01—AC-26、独立业务样本分布及发布门槛不因 UI 通过而记为完成。

本文件的复选框均为未执行计划。计划撰写完成后可由用户另行指定当前会话执行或授权子代理执行；
不因选定了实现方案而自动开始编码。

## 计划自检记录

已对照规格核对覆盖：UI-01 对应任务 2/5；UI-02/03 对应任务 1；UI-04 对应任务 2；
UI-05 对应任务 3/4 及配套 S1—S6；UI-06 对应任务 1/5。DB-08 不被 UI 占位替代，
步骤二与业务交互没有纳入本步实现。

两份计划共 11 个任务组、89 个未执行步骤/闸门；6 处本地引用与锚点、23 段 TypeScript 示例的语法检查通过，
未发现占位标记或未闭合代码围栏。该语法检查不解析未来源码依赖、不等于 TypeScript 全项目类型检查。
本次仅新增计划文档，没有执行计划中的安装、应用测试、构建、迁移、清理、提交或部署。

**2026-10-22 修订（审查结论）：**主计划补入首屏“会话 → 上下文 → 列表”的固定次序与 `legacy_export` 下载动作的 props 变更，
5.3 增加 UI-05 到期/迁移/缺配置状态的合成库预置方式，UI-02 验收补“完整标题查看”；配套计划修正会话状态优先级、
guardIn 动词语义、readPolicy 可空类型、清理范围（会话输入/临时派生数据/空会话行）、ready 失败语义、
cookie Secure 条件及旧 cookie 断言等（详见配套计划修订记录）。任务与闸门数量不变；修订后重新核对本地引用与
TypeScript/SQL 示例语法，仍为计划文本核对，不构成实施或验收结果。
