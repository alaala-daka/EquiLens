// 离线交接示例：合成桩仅演示参数和返回格式，不调用真实模型、不作合同判断。
import { loadRulePack } from "../src/pack"
import { reviewContract, type AskModel } from "../src/review"

const syntheticModel: AskModel = async ({ user }) => ({
  text: JSON.stringify({
    findings: [...user.matchAll(/### 规则 ([A-Z]+-\d+)/g)].map(match => ({
      ruleId: match[1], kind: "待核实", risk: "离线接口示例，没有执行模型审查。",
      severity: "一般关注", quote: "", paragraphIndex: -1, basis: [], impact: "",
      suggestion: "接入真实网关并完成规则核对后重新审查。", pending: ["此响应为合成桩，需真实模型与人工复核。"],
    })),
  }),
})

const result = await reviewContract({
  pack: await loadRulePack("tools/contract-review/rules"),
  documentText: "【合成合同片段】工程验收后，发包人应及时向专业分包人支付工程款。",
  documentTitle: "离线交接示例",
  context: { role: "专业分包人", projectType: "房建机电安装专业分包", region: "上海" },
  mode: "debug", model: syntheticModel, modelName: "synthetic-offline",
})
console.log(JSON.stringify(result, null, 2))
