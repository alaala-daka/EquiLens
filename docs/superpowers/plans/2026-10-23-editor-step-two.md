# 编辑器完善：步骤二实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `subagent-driven-development` 逐任务实施及审查；按复选框记录实际进度。实施须有用户执行指令；本计划本身不授权提交、推送、部署或业务开放。

**Goal:** 在现有 DOCX 闭环上完善编辑状态、保存与导出反馈、离开保护、异常恢复及响应式，按 UI-07—UI-13 和相关 WD/DB 验证交付。

**Architecture:** 保持单个 Next.js 应用、匿名会话文档 API 和固定版本 SuperDoc。以专用编辑会话控制器管理保存版本、编辑状态和操作阶段，React 组件负责官方组件组合、焦点和生命周期；引擎生命周期与序列化保护留在画布适配层。

**Tech Stack:** Node.js 24、pnpm 11.6.0、Next.js 16.4.2、React 19.3.0、TypeScript、superdoc 1.47.2、现有 shadcn/ui Radix / Nova、Node.js test runner + tsx。

## Global Constraints

- 契约入口：[spec/README.md](../../../spec/README.md)；范围：[工作台 §4、§6—7](../../../spec/02-workbench-ui.md)、[Word](../../../spec/03-word-editing.md)、[数据库](../../../spec/04-database-deployment.md)。计划不取代这些契约。
- “桌面默认编辑器 70%、Agent 30%，沿用现有最小比例 35% 和 25%，允许拖动及键盘调整。”
- “视口小于 768 CSS px 时按编辑器在上、Agent 在下纵向排列，默认比例相同”；沿用 useSyncExternalStore，不因方向变化重建引擎。
- “本步不持久化面板比例，不引入跨设备布局同步。”
- “正文采用引擎官方画布与工具栏，不重做 Word Ribbon，不开放未验证的 Word 特性。”
- “保存和 Ctrl/Cmd+S 使用同一操作。未修改时快捷键不创建冗余版本。”
- “步骤一、二允许编辑和保存待发送内容，发送按钮禁用”；不调用模型、展示模拟回复或开发装饰文案。
- 保存/导出/复制前保留实际服务端访问预检；到期或上下文失效按现有会话规则清除资源，不能经缓存、另存或离开确认绕过。
- 导出只使用明确保存版本的原有字节；不以原件回退、重新生成或较新的预检响应替代。
- Node.js 24、pnpm 11.6.0；不升级 SuperDoc，不增加状态库、组件库、测试渲染器、云服务或独立服务。
- 原件、旧版本、prompt 及 source/copy 关系保持现有契约；不自动上传历史 IndexedDB，不新增自动保存或历史浏览。
- 先读官方 Blocks 与实际组件示例源码，沿用现有中性色和系统字体；自定义样式只解决具体可访问性/响应式要求并记录原因。
- 测试只用合成或明确授权材料；凭据、正文、下载字节不进入公共目录、日志或截图。不把 UI/WD/DB 结果计入法律业务准确率。
- 本计划为准备交付；本次没有运行以下测试，也没有预写通过结果。

---

## 基线、范围与依赖

准备基线 `64d11f9c60cd478fe643d6020d21d73f3f073175`，分支 `codex/workbench-step-one`，核查开始时干净。
详见[准备核查](../../reviews/2026-10-23-editor-step-two-readiness.md)。已有列表与编辑闭环可用于本步；
第一步完整验收尚有缺口，继续独立保留，不将本步开工写成第一步全部通过。

顺序：任务 1 → 2 → 3 → 4 → 5 → 6。每项完成后检查其交付和规范符合性，再进入下一项。
计划允许合同纵向联调的独立准备按工作台规格并行，不以全部视觉/人工 Word 回归完成作为业务准备的额外门槛。
实际开工日和产品 Demo D1—D12 仍按产品规格 §13 登记，本计划不指定日历工期。

| 文件 | 改动与单一职责 |
| --- | --- |
| `src/lib/documents/editor-session.ts`、`.test.ts` | 新建：编辑状态、操作互斥、明确版本、重试和异步代次；无 DOM/引擎供应商依赖 |
| `src/lib/documents/engine-lifecycle.ts`、`.test.ts` | 新建：一次画布加载的有效性、超时、取消及迟到清理；无服务器授权判断 |
| `src/components/word-canvas.tsx` | 修改：引擎状态通知、按用户确认重新加载、实例与导出生命周期保护 |
| `src/lib/documents/serialize.ts`、`.test.ts` | 最小修改：必要时暴露底层导出结束信号，保留回退/文字/超时拒绝；不放导航逻辑 |
| `src/components/document-editor.tsx` | 修改：控制器组合、状态反馈、快捷键和导航意图 |
| `src/components/editor-leave-dialog.tsx` | 新建：官方 Alert Dialog 的三选一及焦点返回；不写入文档 |
| `src/components/workbench.tsx` | 最小修改：保存更新列表、复制切换、上下文失效和 dirty 回传，不增加新导航 |
| `src/hooks/use-mobile.ts`、`src/components/ui/resizable.tsx` | 优先复用；只有实际缺陷才修改，不能为静态样式做无关重构 |
| `README.md`、`DEVELOPMENT.md` | 实施后更新实际操作与已验证边界 |
| `docs/reviews/2026-10-23-editor-step-two-validation.md` | 实施时新建：源码、命令、浏览器操作、原始结果摘要、截图和未执行项 |

实施开场先执行 `git status --short --branch`、`git log -3 --oneline`，确认准备基线是否变化。
收到实施指令后从保留本次准备文档的状态创建 `codex/editor-step-two`；名称已存在时先检查，不强制重置。
隔离合成库，避免使用默认 `data/equilens.sqlite`。每任务提交如获授权，只暂存明确路径，不使用 `git add .`。

## 任务 1：可验证的编辑会话与保存操作

**Files:** 新建 `src/lib/documents/editor-session.ts`、`editor-session.test.ts`。

**Consumes:** `OpenDocument`、`documentTitle`、`saveDocument`/`createDocument` 的既有参数及错误类型。
**Produces:** 以下控制器接口；组件与测试使用同一实现，不能为测试另建平行状态机。

```ts
import type { OpenDocument } from "./types"
import type { DocumentSessionError } from "./client"
import type { saveDocument, createDocument } from "./client"

export type EditorIntent = "save" | "export" | "copy" | "reload"
export type EditorPhase = "idle" | "checking" | "serializing" | "saving" | "exporting"
export type EngineState = "loading" | "ready" | "failed"
export type EditorSnapshot = {
  saved: OpenDocument
  title: string
  prompt: string
  dirty: boolean
  phase: EditorPhase
  engine: EngineState
  conflict: boolean
  error: string | null
}
export type EditorDependencies = {
  opened: OpenDocument
  serialize: () => Promise<Blob>
  preflight: (options: { signal: AbortSignal; copy: boolean }) => Promise<void>
  save: typeof saveDocument
  copy: typeof createDocument
  download: (blob: Blob, title: string) => void
  onSaved: (saved: OpenDocument) => void
  onSessionUnavailable: (error: DocumentSessionError) => void
}
export function createEditorSession(deps: EditorDependencies): {
  subscribe(listener: () => void): () => void
  getSnapshot(): EditorSnapshot
  editTitle(value: string): void
  editPrompt(value: string): void
  markBodyChanged(): void
  setEngine(state: EngineState, message?: string): void
  run(intent: EditorIntent): Promise<OpenDocument | null>
  activate(): void
  dispose(): void
}
```

- [ ] **1.1 写行为红测。**用真实 `OpenDocument` 夹具（`blankDocx()`、固定文档/版本 UUID 和时间）与注入服务创建控制器。
  每个测试都统计 serialize/save/copy/download 次数及参数；用 deferred Promise 控制先后，不依赖长 sleep。
  首个可直接运行的测试如下，后续测试分别创建控制器，不共享可变状态：

```ts
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { blankDocx } from "./docx"
import type { saveDocument } from "./client"
import type { OpenDocument } from "./types"
import { createEditorSession } from "./editor-session"

test("UI-08/11: clean save is a no-op and export uses the saved Blob", async () => {
  const blob = blankDocx()
  const documentId = "b1a11947-5a33-4c85-a395-11ba73776eb1"
  const revisionId = "bf3bd91a-97d4-4a35-bf58-06d19fca9551"
  const at = "2026-10-23T02:00:00.000Z"
  const opened: OpenDocument = {
    document: { id: documentId, title: "合成合同", prompt: "", source: "authored",
      createdAt: at, updatedAt: at, currentRevision: revisionId },
    revision: { id: revisionId, documentId, parentId: null, blob,
      hash: createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex"),
      createdAt: at, editorVersion: "superdoc@1.47.2", templateVersion: null },
  }
  let serializeCalls = 0
  const saveCalls: Parameters<typeof saveDocument>[0][] = []
  const downloads: { blob: Blob; title: string }[] = []
  const session = createEditorSession({
    opened,
    serialize: async () => { serializeCalls++; return blob },
    preflight: async () => {},
    save: async input => {
      saveCalls.push(input)
      return {
        document: { ...opened.document, title: input.title, prompt: input.prompt,
          currentRevision: input.operationId },
        revision: { ...opened.revision, id: input.operationId,
          parentId: input.baseRevision, blob: input.blob },
      }
    },
    copy: async () => { throw new Error("unexpected copy") },
    download: (bytes, title) => { downloads.push({ blob: bytes, title }) },
    onSaved: () => {},
    onSessionUnavailable: () => { throw new Error("unexpected access error") },
  })
  try {
    session.activate()
    session.setEngine("ready")
    await session.run("save")
    assert.equal(saveCalls.length, 0)
    assert.equal(serializeCalls, 0)
    session.editPrompt("核对付款条款")
    await session.run("save")
    assert.equal(saveCalls.length, 1)
    assert.equal(saveCalls[0].prompt, "核对付款条款")
    assert.equal(session.getSnapshot().dirty, false)
    await session.run("export")
    assert.strictEqual(downloads[0].blob, session.getSnapshot().saved.revision.blob)
    assert.equal(serializeCalls, 1)
  } finally { session.dispose() }
})
```

- [ ] **1.2 运行并记录红灯。**`pnpm exec tsx --test src/lib/documents/editor-session.test.ts`，新模块尚不存在时应失败。
  环境启动失败不算测试红灯；解决运行环境后再记录实际断言失败或缺模块原因。
- [ ] **1.3 实现控制器。**用闭包保存稳定 snapshot 和 listeners，沿用列表 store 的 subscribe 模式。
  `run` 在任何 await 前占用互斥锁；loading/failed 的保存/导出/复制、冲突普通保存/导出、重复运行均返回 null 且不执行依赖。
  clean save 为 no-op；clean export 先预检后下载 `saved.revision.blob`，绝不 serialize。
  dirty save/export 与 copy 先预检、序列化，再调用现有服务。整个操作锁定标题、prompt、正文，run 也须守卫编辑方法，
  不能只靠 disabled 属性；事务成功才替换 saved、清 dirty、回调 onSaved。export 继续下载本次保存返回的同一 Blob。
  phase 依次准确反映 checking/serializing/saving/exporting，完成或失败后 idle，失败保留输入和保存版本。
- [ ] **1.4 加入重试和冲突测试后实现。**同一未变编辑快照在保存请求结果不明后重试，复用已序列化 Blob、baseRevision、operationId、title/prompt；
  不再次序列化产生新摘要。不自动重试 HTTP。不变请求成功只能生成一个版本；编辑发生变化则不能复用旧快照或将旧成功清掉新 dirty。
  普通保存遇 `RevisionConflict` 后保持冲突，后续保存/导出包括快捷键都无副作用；copy 是显式新文档，来源为原文档及基础版本，保留 prompt。
  copy 没有新增幂等 API：互斥期间只提交一次；结果不明时不自动重复创建，不把保存重试保证扩大到复制。
  `run("reload")` 只在外壳处理完未保存确认后调用；它允许 failed 引擎，仍执行同一预检和互斥。
  成功时将 title/prompt 恢复 saved 值、清 dirty、使 engine=loading，返回 saved 供外壳重建画布；不 serialize、不写版本。
  保留已知修订冲突标记，不能靠重载跳过冲突保护；预检失败保留当前输入，不提前清空。
- [ ] **1.5 加入迟到与权限测试。**dispose 立即取消 fetch、使旧代次无效；即使依赖忽略 abort，迟到成功不能 onSaved/download。
  activate 用于 effect setup，dispose 用于 cleanup；dispose→activate 允许 Strict Mode 同一控制器重新连接，
  但新一代连接不得接受先前请求结果。初始未激活及已 dispose 时 run 无副作用。
  会话失效错误传给既有 onSessionUnavailable，不继续另存或本地导出；409 会话错误不能变成 RevisionConflict。
  checking/serializing/saving/exporting 每个 deferred 边界测试重复提交与 dispose。
- [ ] **1.6 验证交付。**聚焦测试及 `pnpm check`；报告红/绿命令、输入、结果与新接口。
  审查通过后再集成 UI；不因控制器通过而宣称浏览器状态已通过。

## 任务 2：画布就绪、异常与安全重试生命周期

**Files:** 新建 `engine-lifecycle.ts`、`engine-lifecycle.test.ts`；修改 `word-canvas.tsx`，必要时修改 `serialize.ts`、`serialize.test.ts`。

**Consumes:** 固定 `superdoc@1.47.2` 包内实际类型、现有校验 Worker、serializeWord 和文字快照保护。
**Produces:** WordCanvas 保持 serialize 句柄，新增 `reloadToken: number` 与稳定 `onStateChange(state: EngineState, message?: string)` 回调，
替代只报错文字/单向就绪通知；onChange 保持原义。初始加载与一次明确重试共用同一生命周期实现。

```ts
export function createEngineLoad(options: {
  timeoutMs: number
  onTimeout: () => void
}): {
  signal: AbortSignal
  isCurrent(): boolean
  ready(): boolean
  dispose(): void
}
```

- [ ] **2.1 写红测并运行。**`pnpm exec tsx --test src/lib/documents/engine-lifecycle.test.ts`。
  测 ready 解除计时且只能首次成功、dispose 后迟到 ready=false、超时只通知一次并使 signal aborted、dispose 幂等。
  测试用可控计时器或短测试时限，不等待真实 60 秒；断言旧加载不能构造/激活新引擎。
- [ ] **2.2 实现并接入。**每次画布 effect 拥有一个 gate、AbortController、引擎及 DOM；timeoutMs=60000。
  loading → ready/failed 状态传至控制器；onContentError/onException 禁用依赖引擎的操作，保留能保留的画布及输入，显示实际安全错误。
  发生异常后的 failed 不是已保存，也不能继续序列化；不自动清空内容或立即重建。
  取消、超时、卸载均解除计时/事件、销毁拥有的实例和 DOM，迟到依赖创建的实例必须销毁。
  只在文档 Blob 或用户确认的 reloadToken 改变时重载；稳定回调，标题、prompt、面板方向不进入重建依赖。
- [ ] **2.3 验证序列化超时边界。**用 deferred exporter 写测试：上层超时拒绝后底层 Promise 尚未 settle；
  期间不能恢复为可继续导出状态或开启第二次导出。使用当前实例的单次 pending 标识阻止重入；
  最终 settle 时才释放该实例的锁，且只允许仍属当前实例的 finally 恢复 editable/快照。
  超时后提示保留内容，允许用户经离开保护重新加载；旧实例销毁后的迟到 resolve/reject 不得改写新实例。
  不宣称 AbortController 能取消供应商内部导出，也不为使测试变绿删掉 60 秒超时。
- [ ] **2.4 复查既有保护。**保留 JSON/text 快照、导出前后文字一致性、服务端和客户端 DOCX 校验、异常计数及拒绝原件回退。
  所有引擎调用均位于客户端，不能在模块导入、SSR 或构建时访问 window、Worker 或实例。
- [ ] **2.5 运行聚焦与回归。**`pnpm exec tsx --test src/lib/documents/engine-lifecycle.test.ts src/lib/documents/serialize.test.ts`，再 `pnpm check`。
  真正 Strict Mode 工具栏数目、中文编辑和引擎异常仍留到浏览器验收，纯 gate 测试不能代替。

## 任务 3：集成保存反馈、冲突另存与明确版本导出

**Files:** 修改 `document-editor.tsx`；最小修改 `workbench.tsx`；复用现有 client，不改 HTTP/数据库结构。

**Consumes:** 任务 1 控制器、任务 2 WordCanvas 状态接口；现有 `preflightEditorAccess`、saveDocument、createDocument。
**Produces:** 编辑器统一操作入口、准确的可读取状态与既有 onSaved/onCopy/onSessionUnavailable/onDirtyChange 回调。

- [ ] **3.1 读取官方示例。**Blocks 中 dashboard 的结构不适用于此工作区，沿用规格已选组合；读取官方
  [Button](https://ui.shadcn.com/docs/components/radix/button)、[Badge](https://ui.shadcn.com/docs/components/radix/badge)、
  [Input Group](https://ui.shadcn.com/docs/components/radix/input-group)、[Empty](https://ui.shadcn.com/docs/components/radix/empty)实际示例和本地组件。
- [ ] **3.2 绑定唯一状态来源。**通过 useSyncExternalStore 订阅编辑控制器，WordCanvas 的句柄通过已提交生命周期桥接；
  不在 render 读写 canvas ref，不在每次 render 新建控制器；effect setup 调 activate、cleanup 调 dispose，
  同一控制器的重新激活不能复活旧请求。拆除旧 persist/busy/conflict 重复逻辑，保持稳定回调。
  画布加载 Blob 独立初始化为 opened.revision.blob；普通保存成功不改变该 prop，不因保存重建引擎。
  仅明确 reload 成功时同时设置加载 Blob 为控制器 saved.revision.blob、递增 reloadToken，React 同一批提交只触发一次重载。
  外壳映射如下，保存/导出错误用独立 role=alert，不用成功状态掩盖：

```ts
const phaseLabel = {
  checking: "正在核对访问权限",
  serializing: "正在保存",
  saving: "正在保存",
  exporting: "正在导出",
} as const
// idle + dirty → 未保存；idle + !dirty → 已保存。
// engine=loading → 正在打开文档；engine=failed → 实际错误及受保护重试入口。
```

- [ ] **3.3 锁定正确输入。**非 idle 时标题、prompt、画布 inert 并禁用依赖操作；引擎未 ready 禁用保存/导出。
  只影响本操作需要锁定的输入；状态文本用 role=status/aria-live=polite，避免重复播报正文。
  显示“已保存”代表服务端版本，而非浏览器开始下载；不添加“已下载”。
- [ ] **3.4 绑定回调。**保存成功 upsert 服务端 document 元数据；另存成功更新列表并切换到新文档 ID，prompt 随副本保存。
  会话错误继续走 Workbench.unavailable；组件卸载 dispose 控制器，快速切换后旧回调无效。
  导出使用现有安全文件名/download 机制，Blob URL 到时或清理释放；失败保留版本，允许同版本重试。
- [ ] **3.5 运行控制器/访问/存储测试与 check。**

```powershell
pnpm exec tsx --test src/lib/documents/editor-session.test.ts src/lib/documents/editor-access.test.ts src/lib/documents/storage.test.ts src/server/documents/repository.test.ts
pnpm check
```

  浏览器验证 dirty 标题/正文/prompt 均进入未保存；无修改保存按钮禁用，导出不序列化；保存失败仍保留三处输入。
  此任务不增加项目/退出登录等尚不存在入口。

## 任务 4：离开保护、快捷键及有保护的引擎重新加载

**Files:** 新建 `editor-leave-dialog.tsx`；修改 `document-editor.tsx` 和必要的 `workbench.tsx` 接线。

**Consumes:** EditorSnapshot 与 run，WordCanvas.reloadToken；当前返回列表/复制成功回调。
**Produces:** 一个导航意图入口，返回和重新加载共用保护，不分别维护两套 dirty 状态。

```ts
type LeaveTarget = "list" | "reload"
type EditorLeaveDialogProps = {
  open: boolean
  busy: boolean
  canSave: boolean
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
}
```

- [ ] **4.1 读取 Alert Dialog 文档、实际 demo/组件源码及本地实现。**保留 Header/Title/Description/Footer、Cancel/Action 和焦点模式。
  异步保存按钮不能在请求开始时自动关闭对话框并丢掉错误/焦点；必要时 preventDefault 后由成功结果控制关闭。
- [ ] **4.2 实现意图处理。**clean+idle 直接执行目标；dirty 弹“保存并离开 / 放弃更改 / 取消”；busy 阻止新意图。
  保存成功才返回；失败或冲突留在编辑器并保留输入，冲突继续提供另存，不允许通过保存并离开绕过。
  引擎失效无法保存时禁用该选择，仍可取消保留内容或明确放弃后重新加载已保存版本。
  reload 确认后调用 run("reload")，成功才递增 reloadToken，用返回的 saved.revision.blob 重新挂载画布，
  同时采用其标题/prompt；不自动读取较新服务端版本覆盖本地。拒绝时走会话失效；不能以重新加载恢复已撤销访问。
- [ ] **4.3 绑定快捷键。**Ctrl/Cmd+S preventDefault 后只调用 run("save")，使用和按钮相同的 ready/busy/conflict/dirty 守卫。
  同一键重复触发不新增版本；分别核对标题、Word 正文和 Agent textarea 内触发，不能和引擎快捷键双重保存。
  仅 dirty 或真实 pending 时安装 beforeunload，销毁时移除；浏览器原生提示单独验证，不伪造自定义原生文案。
- [ ] **4.4 恢复焦点与失败反馈。**取消、Esc 后恢复触发按钮，保存失败可读错误且焦点仍可操作；离开成功后的焦点落到列表合适入口。
  若原触发元素已移除，使用仍存在的返回/重试控件；不把焦点丢到 body 作为正常行为。
- [ ] **4.5 验证三选一与失败。**实际编辑后分别取消、放弃、保存离开；注入一次保存 503、一次修订冲突，均不得离开。
  编辑后重试引擎必须同样确认；取消不发重载，确认只重建一次；权限失效直接撤下受限资源，保留未保存告知而非继续导出。
  运行任务 1—3 聚焦测试和 pnpm check，不为纯对话框结构新增镜像实现测试。

## 任务 5：面板、长标题、滚动与键盘布局

**Files:** 修改 `document-editor.tsx`；只有实际必要时改 `word-canvas.tsx` 容器、`use-mobile.ts` 或 `ui/resizable.tsx`。

**Consumes:** 官方 Resizable 与既有 useIsMobile；稳定 WordCanvas 子树；标题/正文/prompt 状态来自控制器。
**Produces:** 满足 UI-07、UI-13 和共用 §6 的界面，不建立第二套视觉系统。

- [ ] **5.1 读取官方 Resizable 源码与实际示例。**重新核对已安装 react-resizable-panels 4.x 类型和键盘语义，
  不复制旧 API 或只凭 demo 截图实现；保留 PanelGroup/Panel/Handle 结构。
- [ ] **5.2 适配容器。**桌面70/30、min35/25，小于768px纵向；不为方向切换给画布添加变化的 key。
  页头 flex-wrap、必要 min-w-0/min-h-0，正文/Agent 独立滚动，操作与输入始终可达。Word 固定页宽留在画布内滚动。
  Agent 文档名可换行完整显示或有键盘可操作的完整查看方式；仅 title 属性/鼠标悬停不满足要求。
- [ ] **5.3 按官方模式核对调整柄。**可聚焦、有名称、方向和当前值，键盘能调整；窄屏操作不抢 Word 编辑按键。
  不新增任意 Tailwind 值/色彩/阴影；必要容器或溢出适配逐项记录原因。
- [ ] **5.4 执行实际浏览器矩阵。**1440×900、1024×768、390×844，另测767/768断点往返与真实200%缩放。
  先输入正文/prompt和长标题，再调整/切换方向，确认内容不丢、引擎未重建且无重复工具栏。
  纯键盘遍历返回、标题、保存、导出、调整柄、prompt、对话框；发送仍禁用，焦点可见无陷阱。
  CSS缩小、deviceScaleFactor、截图缩放不替代浏览器缩放；没有实际手段则记录未执行。
- [ ] **5.5 验证交付。**pnpm check；保存桌面/窄屏/缩放截图及官方来源/偏离说明。
  正文样本仅合成，截图不展示cookie、连接串或私有来源。静态布局不新增无意义测试。

## 任务 6：集成回归、剩余验收与交付记录

**Files:** 更新 README、DEVELOPMENT；新建 `docs/reviews/2026-10-23-editor-step-two-validation.md`，
截图位于 `docs/reviews/assets/editor-step-two/`，合成 DOCX/数据库/凭据检查点留在忽略目录。

**Consumes:** 任务 1—5 冻结后的实际代码；现有 fixtures、smoke 与数据库 smoke 脚本。
**Produces:** 可复核的 UI-07—UI-13 记录，关联 WD/DB 的通过、失败、未执行三类结果，不代替业务 AC。

- [ ] **6.1 固定输入与预期。**运行 `pnpm exec tsx scripts/create-word-fixtures.mts` 生成已有合成表格/分页样本；
  新建样本覆盖中文 IME、格式/列表、普通表格、重复编辑、长标题、两文档prompt隔离；异常覆盖加载超时、序列化失败、保存失败、下载失败、冲突、快速切换、会话失效。
  下载失败通过注入下载适配器抛错和实际浏览器可观察失败分别记录，不把浏览器无下载回执当失败或成功。
  记录 1—20 页样本和 100 页/100,000 字边界的输入、实际耗时及失败，不作未经测量的性能承诺。
- [ ] **6.2 运行工程检查。**按顺序执行，安装/构建不可与共享依赖的测试并行；冻结源码后新变化必须重跑受影响项。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
git diff --check
```

  按本次实际输出记录测试数量、跳过项和错误；历史76pass/1skip不作为本次结果。
- [ ] **6.3 生产运行与重启。**使用未占用端口及独立合成库/日志路径，显式设置 DATABASE_PROVIDER、SQLITE_PATH、APP_ORIGIN、PORT、HOSTNAME、
  ANONYMOUS_DATA_RETENTION_DAYS（仅夹具值，无生产默认）。启动 `pnpm start` 后执行：

```powershell
pnpm smoke http://127.0.0.1:18083
node scripts/smoke-database.mjs http://127.0.0.1:18083 .superpowers/sdd/editor-step-two/checkpoint.json
# 仅停止本次自有实例，同库重启后再核对：
node scripts/smoke-database.mjs http://127.0.0.1:18083 .superpowers/sdd/editor-step-two/checkpoint.json --verify
```

  checkpoint目录先创建且不在public/Git；停止自有实例，不杀用户其他服务。
  验证保存重开、响应丢失后同操作重试、多标签冲突/副本、历史/原件摘要不变；严格跨会话404，不能用400/409/503代替。
- [ ] **6.4 真实浏览器检查。**在同一冻结构建上完成任务 3—5 场景及网络审计；保存前后比对输入、重开和下载 SHA-256。
  构建或源码中途变化则标明每轮对象，不能拼接成一次全量通过。补查第一步 create/restart网络失败及纯键盘/真实缩放，结果单独归档。
- [ ] **6.5 人工与平台检查。**Microsoft Word 实际打开导出，记录产品/版本及中文/格式/表格/分页结果。
  无Word则相关WD未通过；其他编辑器结果单独注明。按既有部署说明验证Linux/容器资产、非root、卷重启和日志恢复；
  缺环境则延续未执行。GaussDB只接受实际版本/模式证据，不从SQLite或驱动可解析推断。
- [ ] **6.6 写验收与操作说明。**README写实际可用操作，DEVELOPMENT链接步骤二验证记录。
  验证记录含commit或工作树摘要、环境、命令退出码、原始失败/修复/重测、截图、官方来源和偏离、未完成项；
  不把旧验证文档中的历史状态直接改为本次通过，不降低范围或删除验收来宣布完成。
- [ ] **6.7 最终自查与独立审查。**核对下表每项证据；检查未跟踪文件、git diff --check及隐私。
  若实施采用子代理，每任务完成后分别进行契约符合性和代码质量审查，修复后复查；最终审查冻结差异。
  技术实现完成、部分验证通过、完整验收通过分开报告。没有提交/部署指令则保留分支和未提交改动供审查。

## 验收映射与完成条件

| 验收 | 任务 | 必需证据 |
| --- | --- | --- |
| UI-07 | 2、5、6 | 比例/最小值、键盘调整、方向切换不重建不丢输入 |
| UI-08 | 1、3、4、6 | 三种修改、服务端成功前不显示已保存、快捷键互斥/clean no-op及重试幂等 |
| UI-09 | 1—4、6 | 序列化/保存/下载失败保留编辑、真正多标签冲突和副本，原版本未覆盖 |
| UI-10 | 4、6 | 返回与reload三选一、原生关闭/刷新保护、保存失败不导航、焦点恢复 |
| UI-11 | 1—3、6 | 无修改导出不序列化，有修改导出等于本次保存字节；原件/旧版本不变 |
| UI-12 | 3、6 | prompt逐文档保存重开、发送禁用、网络无未授权外发、无模拟会话 |
| UI-13 | 2、4—6 | 超时/异常/快速切换/Strict Mode、全键盘、多视口、真实200%缩放 |
| WD-01—WD-12相关回归 | 2、6 | 保留原拒绝/保护契约；Word、IME、格式、表格、网络、资产/许可各按实际记录 |
| DB-01—DB-04及DB-08回归 | 1、3、6 | 版本/隔离/冲突/原子性/期限守卫，不扩写为DB-05—DB-07平台通过 |

完整步骤二交付要求 UI-07—UI-13、共用检查及相关 WD 回归通过。环境缺口可不阻止实现，
但不能关闭相应验收或宣称完整交付。业务AC、完整项目恢复与四业务/三模板不在本步完成声明内。

## 计划自查

- 工作台§4.1—4.3、§6及UI-07—UI-13均有任务和证据落点；保持步骤一会话守卫，不引入项目导航。
- 新接口在任务1/2/4定义，后续任务按相同名称消费；已有服务参数直接复用类型，避免平行协议。
- Strict Mode 的重新激活与旧代次隔离、重新加载时恢复标题/正文/prompt已纳入接口和任务；普通保存不重建画布。
- 重试、超时、权限和导航边界有明确预期；不把异步取消说成撤回已提交事务或终止供应商工作。
- 本次是静态计划自查，尚未实施或运行这些检查；只有实际结果才可勾选任务。
