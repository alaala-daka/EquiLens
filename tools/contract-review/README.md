# 合同审查模块交接说明

当前是开发联调版。提供固定后端入口、本地 CLI、规则包及离线调用示例。
网页按钮、HTTP 接口、持久化任务、数据库保存、人工复核和 DOCX 成果导出由后续集成完成。
当前规则全部待核对，企业审查口径为合成示例；不得将调试报告作为正式法律结论。

本次执行静态检查及解析器打包，自动化测试、真实模型调用、业务准确率和容器运行尚未验证。
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

## 后端的固定入口

仅在 Next.js 的 Node.js 后端、已完成项目权限校验的任务中调用：

    import { reviewText } from "@/server/contract-review"

    const result = await reviewText({
      documentText: "【合成合同片段】验收后应及时支付工程款。",
      documentTitle: "合成联调合同",
      context: {
        role: "专业分包人",
        projectType: "房建机电安装专业分包",
        region: "上海",
      },
      mode: "debug",
      complete: true,
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
| context | 调用方已明确确认的立场、项目类型、地域；不能从甲乙方或文字猜测 |
| documentVersionId / parseSnapshotId | 可选，集成时传入实际已保存版本与快照 ID |
| complete | 输入解析是否完整，默认 true；后端必须根据实际解析状态填写 |
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
      }]
    }

完整对象还含 input、paragraphs、coverage、rejected、usage、model、packVersion 和 createdAt。

- status=success：声明范围内必要检查完成；不代表法律结论已复核。
- status=partial：有可用条目，但有漏答、失败、待核实或未覆盖项。
- status=failed：没有可采用条目或无法开展审查。
- mode=debug：无论 status 是什么，都必须显示调试及未核对声明。
- findings 包含发现问题、未发现问题、缺失条款、待核实。
- paragraphIndex 为零起始编号；-1 表示没有具体引文。缺失条款用 checkedParagraphIndexes 记录检查范围。
- coverage 固定六类；类别不完整时保留待核实状态，已找到的问题仍在 findings 中。
- rejected 是模型条目无效、漏答等记录，errors 是配置、网络、预算等执行错误。
- 输入参数错误可能直接抛出 ReviewError；调用方应捕获并展示其 code/message，不把失败显示成空风险列表。

前端用文字组件显示模型字段，并保留 warnings、待核实、未覆盖和错误。
不要直接把生成文字作为 HTML 渲染，不要只统计发现问题数量就宣布合同无风险。
返回对象包含合同文字，必须保持项目授权及私有响应缓存边界。

## 后端同伴还需衔接的工作

1. 读取用户有权访问的已保存文档版本，取得真实解析快照、完整性及确认事实。
2. 持久化任务、幂等键和输入版本，按现有架构的进程内任务执行器调用服务。
3. 通过 reviewText(input, settings) 传入 signal、callsUsed 和剩余 timeoutMs。
   onBeforeCall({ callNumber, ruleIds }) 应在每次外发前持久化预算并复查权限；
   回调失败不会发请求。callsUsed 包含失败或不确定的预算占用，不能当作精确计费次数。
4. 保存整个结果及版本关系，提供查询、人工处理和历史访问。
   本模块没有跨恢复存储或租约实现，内存计数不能代替数据库任务预算。
5. 超过本模块输入预算、无法可靠提取的文件进入明确错误或不完整状态。

模型适配器每次只发送一次请求，重试由 reviewContract 统一管理。
注入自定义 AskModel 时必须遵守单请求和 AbortSignal 约定，不能在内部偷偷重试。
Next.js standalone 构建会复制规则包；依赖或规则更新后需要重新构建镜像。
当前没有公开的合同审查 HTTP 地址，网页无法直接用 fetch 调用此模块。

## 本地文件联调

先把模型配置填写在本机 .env.local，再运行以下真实调用（会产生费用）：

    pnpm review:contract --contract tools/contract-review/fixtures/sample-contract.txt --debug --role 专业分包人 --project-type 房建机电安装专业分包 --region 上海

在末尾增加 --dry-run 只显示计划检查的规则与关键词线索，不调用模型。
DOCX 使用同一命令并替换文件路径。CLI 会生成隔离解析器，保持正文/表格的顺序和单元格行列。
支持 UTF-8 TXT 与通过主应用校验器的基础 DOCX；图片、页眉页脚、域、修订、外链、
嵌套表格等不支持内容明确拒绝，不当成已完整解析。PDF 由后端后续提供解析快照。

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

待执行检查：

    pnpm test:contract
    pnpm check
    pnpm test
    pnpm build

新增测试已接入默认 pnpm test 和现有 CI，全部使用合成数据或模型桩。
本次按用户要求不执行测试、不调用真实模型；也未运行离线示例或生产构建。
本次已通过 TypeScript、ESLint、解析器打包、JSON/来源编号关联检查及 git diff --check；
扫描交接源码与规则未发现密钥模式，临时输出及 .env.local 已确认被 Git 忽略。
静态检查不替代上述测试或独立业务验收。本次交接使用上述开发分支，未合并主分支或部署。
