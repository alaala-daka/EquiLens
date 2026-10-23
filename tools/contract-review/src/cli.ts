import { mkdir, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { parseDocument } from "./document"
import { ReviewError, safeError } from "./errors"
import { createGatewayAskModel } from "./gateway"
import { matchRules } from "./match"
import { loadRulePack, publishedRules } from "./pack"
import { toJson, toMarkdown } from "./report"
import { defaultSceneId, isSceneId, sceneContext, sceneOf } from "./scenes"
import { reviewContract } from "./review"
import { buildOutline, buildSegments } from "./segments"
import type { ReviewContext } from "./types"
import { reviewWithAgent } from "./agent"

type CliOptions = {
  file: string; rules: string; outDir: string; title?: string
  format: "json" | "markdown" | "both"
  dryRun: boolean; debug: boolean; agent: boolean; batchSize: number; context: ReviewContext
}
const usage = [
  "用法：pnpm review:contract --contract <基础.docx 或 UTF-8.txt> [选项]",
  "--debug / --include-unpublished：显式使用未核对资料，仅供开发联调",
  "--dry-run：只查看必检规则和关键词线索，不调用模型",
  "--rules <目录>  --out <目录>  --format json|markdown|both  --title <标题>",
  "--role <确认的审查立场>  --scene <场景标识>  --region <确认的地域>",
  "--batch <1到20>：固定编排每批规则数，默认7；固定编排合计最多3次请求",
  "--agent：使用 AI SDK Agent + skill + 工具；联调默认最多8次模型请求，可配置 AI_AGENT_MAX_CALLS（1–25）",
  "真实审查会发送所选合同文字并产生模型费用。调试结果必须人工核对。",
].join("\n")

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    file: "", rules: sceneOf(defaultSceneId).rulesDir, outDir: "tools/contract-review/output",
    format: "both", dryRun: false, debug: false, agent: false, batchSize: 7,
    context: sceneContext(defaultSceneId),
  }
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new ReviewError("REVIEW_INPUT_INVALID")
      return value
    }
    switch (argv[i]) {
      case "--": break
      case "--contract": options.file = next(); break
      case "--rules": options.rules = next(); break
      case "--out": options.outDir = next(); break
      case "--title": options.title = next(); break
      case "--scene": {
        const value = next()
        if (!isSceneId(value)) throw new ReviewError("REVIEW_INPUT_INVALID")
        Object.assign(options.context, sceneContext(value))
        break
      }
      case "--role": options.context.role = next(); break
      case "--project-type": options.context.projectType = next(); break
      case "--region": options.context.region = next(); break
      case "--batch": options.batchSize = Number(next()); break
      case "--format": {
        const format = next()
        if (format !== "json" && format !== "markdown" && format !== "both") throw new ReviewError("REVIEW_INPUT_INVALID")
        options.format = format
        break
      }
      case "--debug":
      case "--include-unpublished": options.debug = true; break
      case "--dry-run": options.dryRun = true; break
      case "--agent": options.agent = true; break
      case "--help": console.log(usage); process.exit(0); break
      default: throw new ReviewError("REVIEW_INPUT_INVALID")
    }
  }
  if (!options.file || !Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 20) throw new ReviewError("REVIEW_INPUT_INVALID")
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  // 只忽略本地环境文件不存在；读取失败不输出文件内容。
  try { process.loadEnvFile(".env.local") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ReviewError("AI_CONFIG_INVALID") }
  const pack = await loadRulePack(resolve(options.rules)).catch(() => { throw new ReviewError("REVIEW_RULE_PACK_INVALID") })
  const parsed = await parseDocument(resolve(options.file))
  const segments = buildSegments(parsed.paragraphs)
  if (options.dryRun) {
    const rules = pack.manifest.status === "已停用" ? [] : options.debug
      ? pack.rules.filter(rule => rule.status !== "已停用") : publishedRules(pack)
    const planned = matchRules(rules, parsed.paragraphs, options.context)
    console.log("模式：" + (options.debug ? "开发调试，资料未核对" : "仅已发布规则"))
    for (const warning of pack.warnings) console.warn(warning)
    console.log("段落数：" + parsed.paragraphs.length + "；条款块：" + segments.length + "；本次计划检查：" + planned.length + " 条")
    console.log("全文目录：\n" + buildOutline(segments))
    for (const item of planned) console.log(item.rule.ruleId + "：关键词定位 " + item.excerpts.length + " 处，没有命中也执行必检")
    return
  }
  const configured = process.env.AI_REVIEW_MAX_PROMPT_CHARS?.trim()
  if (!options.debug && !configured) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const common = {
    pack, paragraphs: parsed.paragraphs, complete: parsed.complete, context: options.context,
    documentTitle: options.title ?? basename(options.file),
    mode: options.debug ? "debug" as const : "published" as const,
    maxPromptChars: configured ? Number(configured) : 240000,
  }
  const result = options.agent
    ? await reviewWithAgent({ ...common, maxCalls: Number(process.env.AI_AGENT_MAX_CALLS ?? 25) })
    : await reviewContract({ ...common, segments, batchSize: options.batchSize,
      model: createGatewayAskModel(), modelName: process.env.AI_MODEL?.trim() || "glm-5.3-flash" })
  const title = result.documentTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[ .]+$/g, "").slice(0, 80) || "contract"
  const directory = resolve(options.outDir, title + "-" + result.reviewId)
  await mkdir(directory, { recursive: true })
  if (options.format !== "markdown") await writeFile(resolve(directory, "report.json"), toJson(result), { encoding: "utf8", flag: "wx" })
  if (options.format !== "json") await writeFile(resolve(directory, "report.md"), toMarkdown(result), { encoding: "utf8", flag: "wx" })
  console.log("报告目录：" + directory)
  console.log("执行状态：" + result.status + "；模式：" + result.mode + "；调用预算占用：" + result.callsUsed)
  for (const error of result.errors) console.error(error.code + "：" + error.message)
  process.exitCode = result.status === "failed" ? 1 : result.status === "partial" ? 2 : 0
}

main().catch((failure: unknown) => {
  const error = safeError(failure)
  console.error(error.code + "：" + error.message)
  process.exitCode = 1
})
