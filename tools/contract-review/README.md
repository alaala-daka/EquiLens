# 合同审查模块交接说明

当前是开发联调版。提供固定编排与 AI SDK Agent 两条入口、本地 CLI、技能和规则包。
已新增网页审查栏、私有 HTTP 接口和数据库后台任务，范围为现有匿名会话。
账号/项目成员授权、人工复核修订和 DOCX 成果导出由后续集成完成。
当前规则全部待核对，企业审查口径为合成示例；不得将调试报告作为正式法律结论。

2026-10-23 Agent 及网页任务增量的 TypeScript 检查通过，未运行测试、构建、浏览器或真实模型调用。
下文历史验证记录不覆盖此次改动，不能用来宣称 Agent 已验证可运行。
接口契约与预算归属见 [架构规格](../../spec/00-overview.md#合同审查模块的联调契约)，
验收目标见 [产品规格](../../spec/01-product.md)。编写测试不代表业务 AC 已通过。

## 队友如何使用

交接分支为 `feat/contract-review-handoff`，保留目录结构。此模块依赖同一仓库的模型配置、
DOCX 校验器和现有依赖，不能只复制 tools/contract-review。
队友已有仓库时，首次获取该分支：

    git fetch origin
    git switch --track origin/feat/contract-review-handoff

使用 Node.js 24、pnpm 11.6.0；在仓库根目录执行：

    pnpm install --frozen-lockfile
    pnpm review:contract:example

第二条是离线合成桩示例，不读取密钥、不发送网络请求、不进行合同判断。
示例源文件是 examples/local.mts，可用于理解参数与返回对象。
本次没有运行该命令，其运行结果仍待验证。

## AI SDK Agent 入口

新增代码在 `src/agent/`，技能在 `skills/contract-review/`；规则和依据仍由 `rules/` 单独维护。
不是把旧固定流程改名：AI SDK ToolLoopAgent 实际选择工具、读取条款和依据、提交结果。
首版只有一个受支持技能，系统保底六类必检，技能按需读取正文和规则；不会加载任意路径或执行技能脚本。

| 文件 | 职责 |
| --- | --- |
| skills/contract-review/skill.json / SKILL.md | 名称、用途、版本及操作说明 |
| src/agent/skill.ts | 固定技能注册与内容摘要 |
| src/agent/session.ts | 输入快照、规则范围、阅读记录、提交校验和结果汇总 |
| src/agent/tools.ts | loadSkill、parseDocument、searchDocument、readParagraphs、readSources、submitFindings、checkCoverage |
| src/agent/model.ts | AI SDK 兼容网关、发送前计次、单次超时、响应上限及错误脱敏 |
| src/agent/run.ts | 有界工具循环、取消、进度和调用预算钩子 |

后端在已完成权限检查、材料授权和任务输入固定后调用：

```ts
import { reviewTextWithAgent } from "@/server/contract-review"
import { defaultSceneId, sceneContext } from "../../../tools/contract-review/src/scenes"

const result = await reviewTextWithAgent({
  documentText: "【合成示例】工程款在验收后支付。",
  documentTitle: "合成联调合同",
  documentVersionId: "由调用方提供的真实文档版本ID",
  parseSnapshotId: "由调用方提供的真实解析快照ID",
  context: sceneContext(defaultSceneId, "上海"),
  mode: "debug",
  complete: coverageComplete(parsed.coverage), // 由解析覆盖派生（coverageComplete：关键嵌图、修订标记、文本框、复杂结构全零才为 true）
})
```

以上是调用示例，没有运行。实际调用会发送所选文字并产生模型费用。
`scene` 使用 `tools/contract-review/src/scenes` 登记的标识；`sceneContext` 同时填入该场景的立场与展示名称，展示名称不参与匹配。
已有解析快照时用 `reviewSnapshotWithAgent({ paragraphs, ... })`，保留 DOCX 表格行列及原编号。
纯模块入口为 `tools/contract-review/src/agent` 导出的 `reviewWithAgent({ pack, ... })`，便于 CLI 共用。
旧 `reviewText` / `reviewContract` 继续使用固定编排，不会自动切到 Agent。

CLI 从仓库根目录运行（本轮未运行）：

```sh
pnpm review:contract:agent --contract tools/contract-review/fixtures/sample-contract.txt --debug --role 专业分包人 --project-type 房建机电安装专业分包 --region 上海
```

使用现有 AI_BASE_URL、AI_API_KEY、AI_MODEL。AI_AGENT_MAX_CALLS 为 Agent 联调预算，默认 25，
可信后端允许 1–25；每次实际 HTTP 请求计次，SDK 自动重试关闭，工具调用本身不另算模型请求。
单次默认 90 秒、总计最多 600 秒；提示上限沿用 AI_REVIEW_MAX_PROMPT_CHARS，未配置的调试模式暂用 240000 字符。
上限包含工具定义和累计会话；工具结果单次默认最多 16000 字符，超限时明确失败并可减少本次读取段落数。
这些是保护值，不是模型工具能力或容量验证结果。正式模式仍要求显式预算配置和已发布资料。

Agent 后端设置支持 `signal`、`callsUsed`、`maxCalls`、`timeoutMs`、`requestTimeoutMs`、`maxToolChars`，
以及可等待的 `onBeforeCall({ callNumber, ruleIds })`、`onProgress(progress)`。
`onBeforeCall` 由调用方复查权限、租约/执行令牌并持久化预算，失败不会发送请求。
`onProgress` 提供阶段、已读数量和最后工具名，失败停止继续处理；它不是数据库任务实现。
调用方返回 result 后再保存最终状态及报告，不以 progress.stage=completed 判断业务成功。
纯模块不自行连接数据库。网页适配通过 onCheckpoint 保存有效结果、onModelExchange 保存原始请求/响应，
恢复沿用固定快照和保守已用次数，新模型会话重新阅读正文。账号/项目权限仍待后续实现。

引用和覆盖：

- 搜索预览/目录不计已读；完整工具结果经过后续模型请求返回才登记为已读，避免同一回合先读后提交伪造阅读。
- 结论只引用提交时已读段落及已读且规则允许的来源。后读内容不补造先前提交的范围。
- 缺失/无问题结论要求完整解析和全文阅读；局部阅读只能提出有引文的问题或待核实。
- findings 新增可选 citations、sourceReferences 和实际 checkedParagraphIndexes；依据元数据由后端填充。
- 跨段引文可通过可选 citations 数组提交，每项 paragraphIndex、quote，逐项在已读快照中核对。
- result 新增可选 agent（技能版本/摘要、阅读范围、工具轨迹和提交范围）及 summary，原兼容字段保持。
- 未答必检项由后端补为待核实；全部模型候选无效或没有成功提交时状态 failed，保留待核实清单供排障。
- 超时或后续失败保留已接受条目；有有效提交但未完成全范围时为 partial。自然语言总结不作为报告。
- 本版本只校验结构、范围和引文/来源真实性；来源是否支持结论、法律适用和人工复核仍需业务验证。

standalone 打包同时复制 skills/ 与 rules/。依赖锁定为 ai@7.0.148、@ai-sdk/openai-compatible@3.0.75、zod@4.6.7。

## 后端的固定入口

仅在 Next.js 的 Node.js 后端、已完成项目权限校验的任务中调用：

    import { reviewText } from "@/server/contract-review"
    import { defaultSceneId, sceneContext } from "../../../tools/contract-review/src/scenes"

    const result = await reviewText({
      documentText: "【合成合同片段】验收后应及时支付工程款。",
      documentTitle: "合成联调合同",
      context: sceneContext(defaultSceneId, "上海"),
      mode: "debug",
      complete: coverageComplete(parsed.coverage), // 由解析覆盖派生（coverageComplete：关键嵌图、修订标记、文本框、复杂结构全零才为 true）
    })

这是一次真实模型调用，会发送所给合同文字并产生费用。不要在浏览器组件导入或调用。
Next.js 自动读取本机 .env.local；字段见根目录 .env.example。
调用所需变量：AI_BASE_URL、AI_MODEL、AI_API_KEY；密钥只配置在后端环境，不能提交 Git。
正式模式还要求显式设置已验证的 AI_REVIEW_MAX_PROMPT_CHARS，并使用已发布规则包；
内置规则目前无法进行正式审查。调试模式也有输入限制，超限明确失败，不截断。

输入约定：

| 字段 | 含义 |
| --- | --- |
| documentText | 必填，实际选中文档的合同文字 |
| documentTitle | 可选，显示标题 |
| context | 调用方已明确确认的场景标识（scene）、立场、项目类型、地域；scene 是规则判定依据，缺失时会排除带适用场景的规则，不能从甲乙方或文字猜测 |
| documentVersionId / parseSnapshotId | 可选，集成时传入实际已保存版本与快照 ID |
| complete | 输入解析是否完整，由解析覆盖派生（coverageComplete：关键嵌图、修订标记、文本框、复杂结构全零才为 true）；后端必须根据实际解析状态填写 |
| mode | published 或 debug，默认 published；由可信后端固定，不能直接使用客户端传入的开关 |

纯编排函数 reviewContract 支持 documentText 或 paragraphs 二选一。
带段落的集成路径必须保留原来的 index 和 table 行列信息，不能重排。
旧的 includeUnpublished 参数暂作兼容，新代码使用 mode。

## 前端读取什么

reviewText 返回可序列化的 ReviewResult。类型可用 import type 从同一服务端入口导入，
运行时代码必须留在后端。下面是结构节选，数值为手工合成示例，不是运行记录：

    {
      "schemaVersion": 1,
      "reviewId": "本次结果的唯一ID",
      "status": "partial",
      "mode": "debug",
      "warnings": ["调试结果：使用未核对材料，仅用于开发联调，不形成正式法律结论。"],
      "errors": [],
      "callsUsed": 1,
      "findings": [{
        "ruleId": "PAY-001",
        "kind": "待核实",
        "risk": "需要补充付款条件",
        "quote": "",
        "paragraphIndex": -1,
        "basis": [],
        "pending": ["尚需人工确认"],
        "reviewStatus": "待人工复核"
      }],
      "notLocated": [{
        "ruleId": "PAY-004",
        "reason": "outline-only",
        "detail": "未在正文中定位到相关条款，仅依据全文目录判断。"
      }]
    }

完整对象还含 input、paragraphs、coverage、rejected、usage、model、packVersion 和 createdAt。

- status=success：声明范围内必要检查完成；不代表法律结论已复核。
- status=partial：有可用条目，但有漏答、失败、待核实、未覆盖或未定位项。
- status=failed：没有可采用条目或无法开展审查。
- mode=debug：无论 status 是什么，都必须显示调试及未核对声明。
- findings 包含发现问题、未发现问题、缺失条款、待核实。
- paragraphIndex 为零起始编号；-1 表示没有具体引文。缺失条款用 checkedParagraphIndexes 记录检查范围。
- coverage 固定六类；类别不完整时保留待核实状态，已找到的问题仍在 findings 中。
- rejected 是模型条目无效、漏答等记录，errors 是配置、网络、预算等执行错误。
- notLocated 是未定位记录：`no-match` 表示非必检规则未命中线索、未纳入本次检查；`outline-only`
  表示只有目录，没有定位到正文。所有未定位项都会阻止 success，
  前端必须单列展示，不能与"未发现问题"合并。
- 输入参数错误可能直接抛出 ReviewError；调用方应捕获并展示其 code/message，不把失败显示成空风险列表。

前端用文字组件显示模型字段，并保留 warnings、待核实、未覆盖、未定位和错误。
不要直接把生成文字作为 HTML 渲染，不要只统计发现问题数量就宣布合同无风险。
返回对象包含合同文字，必须保持项目授权及私有响应缓存边界。

## 条款块与定向取材

服务端入口 `reviewText` 默认把合同按条款编号切成块，并为每批只取命中块及前后相邻块，
同时附上全文目录；完整合同原文不再每批发送。目的是让长合同能进入审查，而不是整篇超限失败。

- 切块按 `第X条/章/节`、`一、`、`（一）`、`1.1` 等编号识别；无编号时按段落边界累积，不切段落内部。
- 块内保留原段落编号，引文只在本批实际提供的正文内核对；局部范围不接受缺失/无问题结论。
- 某条规则没有命中任何块时，仍会把目录送给模型，并记入 `notLocated`（`outline-only`）。
- 直接调用 `reviewContract` 且不传 `segments` 时保持旧行为，整篇合同随每批发送。
- CLI 的 `--dry-run` 会打印条款块数量与全文目录，便于先确认切分是否合理。

## 正式项目接入仍需衔接的工作

1. 读取用户有权访问的已保存文档版本，取得真实解析快照、完整性及确认事实。
2. 将现有会话任务、幂等键和输入版本绑定到正式项目及成员权限，而不是直接沿用匿名 cookie 授权。
3. 通过 reviewText(input, settings) 传入 signal、callsUsed 和剩余 timeoutMs。
   onBeforeCall({ callNumber, ruleIds }) 应在每次外发前持久化预算并复查权限；
   回调失败不会发请求。callsUsed 包含失败或不确定的预算占用，不能当作精确计费次数。
4. 保存整个结果及版本关系，提供查询、人工处理和历史访问。
   网页任务适配已实现数据库预算和租约；正式项目还需接项目授权、人工修订及业务恢复验收。
5. 超过本模块输入预算、无法可靠提取的文件进入明确错误或不完整状态。

模型适配器每次只发送一次请求，重试由 reviewContract 统一管理。
注入自定义 AskModel 时必须遵守单请求和 AbortSignal 约定，不能在内部偷偷重试。
Next.js standalone 构建会复制规则包；依赖或规则更新后需要重新构建镜像。
网页通过 /api/contract-reviews 的受限任务接口使用本模块，不能从客户端直接导入服务端函数。

## 本地文件联调

先把模型配置填写在本机 .env.local，再运行以下真实调用（会产生费用）：

    pnpm review:contract --contract tools/contract-review/fixtures/sample-contract.txt --debug --role 专业分包人 --project-type 房建机电安装专业分包 --region 上海

在末尾增加 --dry-run 只显示计划检查的规则与关键词线索，不调用模型。
DOCX 使用同一命令并替换文件路径。CLI 会生成隔离解析器，保持正文/表格的顺序和单元格行列。
支持 UTF-8 TXT 与通过主应用校验器的 DOCX；外链、宏、嵌入对象按安全边界拒绝；
图片、修订标记、文本框等结构不再拒绝，超出分析覆盖的类别记入解析覆盖并使 `complete` 为 false。PDF 由后端后续提供解析快照。

报告位于 output/<标题-结果ID>/report.json 和 report.md，重复运行创建新目录。
退出码：0 为完整完成，2 为部分完成，1 为失败；调试模式始终保留未核对标记。
输出和本机临时文件被 Git 忽略，JSON 报告包含原文，应按私有项目资料管理。

## 规则维护与验证

rules/pack.json 声明规则与来源文件。停用的包、规则和来源均不参与调试或正式分析。
规则默认 mandatory=true；即使没有关键词命中也执行场景检查。可选补充规则使用 false。
规则条件采用已确认字段的全部匹配；未知条件待核实，不在合同正文中猜测。

法律条目增加 officialUrl；已纠正已发现的803、804、806条内容并删除不相关错误835条，
来源为 [最高法公布的民法典](https://www.court.gov.cn/zixun/xiangqing/233181.html)。
示范文本修正发布机关与章节位置，内容改为明确标注的审查摘要示例：
[住建部通知](https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2017/art_17339_233757.html)、
[市场监管总局示范文本库](https://htsfwb.samr.gov.cn/View?id=082423f0-e9cb-41a2-b88c-bdc70b5619d8)。
这只是纠错，未完成逐条法律适用核对；reviewer、reviewedAt 保持空，不自动发布。
合成企业规则和摘要 illustrative=true，发布前必须替换为已确认的正式资料。
法条名称/编号、引文校验不能证明法律适用或业务准确性。

验证命令：

    pnpm test:contract
    pnpm check
    pnpm test
    pnpm build

新增测试已接入默认 pnpm test 和现有 CI，全部使用合成数据或模型桩。

2026-10-22 定向取材改造的本地执行结果（Windows，Node.js 24.16.0）：
类型检查、ESLint 与全部 69 项测试通过，其中新增 `segments.test.ts`（6 项）与
`focused.test.ts`（5 项）覆盖切块守恒、定向取材、引文校验与未定位声明。
`--dry-run` 已用合成样例确认条款切分与目录输出。
本次未运行 `pnpm build`、未调用真实模型、未跑业务验收；GaussDB 与页面接入仍为未完成项。
静态检查与单元测试不替代业务质量评测。

上述为 Agent 升级前的历史记录。此次修正了局部范围校验和 outline-only 状态；
旧 focused.test.ts 的两处合成模型回答已同步为有引文的问题，避免局部输入依赖无问题结论。
本轮遵照用户要求未新增测试套件，也未运行测试。
