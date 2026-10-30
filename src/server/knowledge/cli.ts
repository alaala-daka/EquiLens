import { KnowledgeError, isKnowledgeError } from "./errors"
import type { PublicationService } from "./publication"
import type { PublicationKind, PublicationState, PublicationSummary, PublicationVersionDetail } from "./types"

/**
 * Testable private maintenance CLI core for C6.
 *
 * `scripts/knowledge-maintenance.mts` owns only environment/database
 * initialization and file/stdout wiring; argument parsing and command dispatch
 * live here so the state machine, redacted output and exit codes are covered by
 * behavioral tests. There is no HTTP write route for publication maintenance.
 */
export type MaintenanceCliRuntime = {
  service: PublicationService
  env: Record<string, string | undefined>
  readFile: (path: string) => Promise<string>
  output: (line: string) => void
}

export const maintenanceUsage = [
  "用法：",
  "  knowledge-maintenance list [--kind rules] [--artifact <id>] [--scene <scene>] [--state draft|pending_verification|published|disabled]",
  "  knowledge-maintenance show --version <versionId>",
  "  knowledge-maintenance show --kind <kind> --artifact <id>",
  "  knowledge-maintenance validate --kind rules --scene <scene> --file <path>",
  "  knowledge-maintenance submit --kind rules --artifact <id> --scene <scene> --file <path> --operator <accountId> [--reviewer <id>]",
  "  knowledge-maintenance publish --version <versionId> --operator <accountId> --reviewer <id> --verified-at <ISO8601> --expected-sha <sha256> --evidence <text>",
  "  knowledge-maintenance disable --version <versionId> --operator <accountId> --reason <text>",
].join("\n")

const stateLabels: Record<PublicationState, string> = {
  draft: "草稿",
  pending_verification: "待核对",
  published: "已发布",
  disabled: "已停用",
}

class CliUsageError extends Error {}

const commandFlags: Record<string, readonly string[]> = {
  list: ["kind", "artifact", "scene", "state"],
  show: ["version", "kind", "artifact"],
  validate: ["kind", "scene", "file"],
  submit: ["kind", "artifact", "scene", "file", "operator", "reviewer"],
  publish: ["version", "operator", "reviewer", "verified-at", "expected-sha", "evidence"],
  disable: ["version", "operator", "reason"],
}

function parseFlags(argv: string[], allowed: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const raw = argv[index]
    const value = argv[index + 1]
    if (!raw?.startsWith("--") || typeof value !== "string") throw new CliUsageError("维护命令参数不完整。")
    const name = raw.slice(2)
    if (!allowed.includes(name)) throw new CliUsageError(`维护命令包含未知参数：--${name}`)
    if (flags[name] !== undefined) throw new CliUsageError(`维护命令参数重复：--${name}`)
    flags[name] = value
  }
  return flags
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (typeof value !== "string" || !value.trim()) throw new CliUsageError(`维护命令缺少参数：--${name}`)
  return value
}

function formatRef(detail: { versionId: string; version: string; state: PublicationState; sha256: string }): string {
  return `v${detail.version} [${stateLabels[detail.state]}] versionId=${detail.versionId} sha=${detail.sha256}`
}

function printVersion(runtime: MaintenanceCliRuntime, prefix: string, detail: PublicationVersionDetail): void {
  runtime.output(`${prefix}：${detail.kind}/${detail.artifactId} ${formatRef(detail)} 场景=${detail.scene}`)
  if (detail.reviewer) runtime.output(`  核对人：${detail.reviewer}`)
  if (detail.verifiedAt) runtime.output(`  核对时间：${detail.verifiedAt}`)
  if (detail.publishedAt) runtime.output(`  发布时间：${detail.publishedAt}`)
  if (detail.disabledAt) runtime.output(`  停用时间：${detail.disabledAt}`)
  if (detail.disabledReason) runtime.output(`  停用原因：${detail.disabledReason}`)
  if (detail.supersedesId) runtime.output(`  替代版本：${detail.supersedesId}`)
  const content = detail.content
  runtime.output(`  内容：规则包=${content.manifestName ?? "-"} 版本=${content.manifestVersion ?? "-"} 状态=${content.manifestStatus ?? "-"} 规则数=${content.ruleCount} 来源数=${content.sourceCount}`)
  for (const warning of content.warnings) runtime.output(`  提示：${warning}`)
}

function summaryLine(summary: PublicationSummary): string {
  const latest = summary.latestVersion
  if (!latest) return `${summary.kind}/${summary.artifactId}：暂无版本。`
  return `${summary.kind}/${summary.artifactId} 最新 v${latest.version} [${stateLabels[latest.state]}] 场景=${latest.scene} sha=${latest.sha256} 核对人=${latest.reviewer ?? "-"} 停用时间=${latest.disabledAt ?? "-"}`
}

async function readContent(runtime: MaintenanceCliRuntime, path: string): Promise<string> {
  try {
    return await runtime.readFile(path)
  } catch {
    throw new KnowledgeError("INVALID_INPUT", "无法读取发布内容文件。")
  }
}

async function execute(argv: string[], runtime: MaintenanceCliRuntime): Promise<void> {
  const command = argv[0]
  if (!command || command === "help" || command === "--help") {
    runtime.output(maintenanceUsage)
    return
  }
  const allowed = commandFlags[command]
  if (!allowed) throw new CliUsageError("未知的维护命令。")
  const flags = parseFlags(argv.slice(1), allowed)
  switch (command) {
    case "list": {
      const summaries = await runtime.service.list({ kind: flags.kind, artifactId: flags.artifact })
      const filtered = summaries
        .filter(summary => !flags.scene || summary.versions.some(version => version.scene === flags.scene))
        .filter(summary => !flags.state || summary.versions.some(version => version.state === flags.state))
      if (!filtered.length) { runtime.output("暂无发布记录。"); return }
      for (const summary of filtered) {
        runtime.output(summaryLine(summary))
        for (const version of summary.versions) {
          runtime.output(`  v${version.version} [${stateLabels[version.state]}] 场景=${version.scene} versionId=${version.versionId} sha=${version.sha256} 核对人=${version.reviewer ?? "-"}`)
        }
      }
      return
    }
    case "show": {
      const detail = flags.version
        ? await runtime.service.showVersion(required(flags, "version"))
        : await runtime.service.showLatest(required(flags, "kind"), required(flags, "artifact"))
      printVersion(runtime, "发布记录", detail)
      return
    }
    case "validate": {
      const kind = required(flags, "kind")
      const scene = required(flags, "scene")
      const result = runtime.service.validate(kind, scene, await readContent(runtime, required(flags, "file")))
      runtime.output(`校验通过（结构）；sha256=${result.sha256}`)
      runtime.output(`规则包=${result.manifestName} 版本=${result.manifestVersion} 状态=${result.manifestStatus} 规则数=${result.ruleCount} 来源数=${result.sourceCount}`)
      for (const warning of result.warnings) runtime.output(`提示：${warning}`)
      if (result.publishable) runtime.output("可发布：内容已达到发布要求。")
      else for (const blocker of result.publishBlockers) runtime.output(`发布阻塞：${blocker}`)
      return
    }
    case "submit": {
      const detail = await runtime.service.submit({
        kind: required(flags, "kind") as PublicationKind,
        artifactId: required(flags, "artifact"),
        scene: required(flags, "scene"),
        content: await readContent(runtime, required(flags, "file")),
        operatorId: required(flags, "operator"),
        ...(flags.reviewer !== undefined ? { reviewer: flags.reviewer } : {}),
      })
      printVersion(runtime, "已提交", detail)
      return
    }
    case "publish": {
      const detail = await runtime.service.publish({
        versionId: required(flags, "version"),
        operatorId: required(flags, "operator"),
        reviewer: required(flags, "reviewer"),
        verifiedAt: required(flags, "verified-at"),
        expectedSha256: required(flags, "expected-sha"),
        reviewEvidence: required(flags, "evidence"),
      })
      printVersion(runtime, "已发布", detail)
      return
    }
    case "disable": {
      const detail = await runtime.service.disable({
        versionId: required(flags, "version"),
        operatorId: required(flags, "operator"),
        reason: required(flags, "reason"),
      })
      printVersion(runtime, "已停用", detail)
      return
    }
    default:
      throw new CliUsageError("未知的维护命令。")
  }
}

/**
 * Run one maintenance command. Returns process exit code: 0 success, 1 refused
 * operation/known failure, 2 invalid command line. Never prints credentials,
 * database rows, payload text or file paths.
 */
export async function runMaintenanceCli(argv: string[], runtime: MaintenanceCliRuntime): Promise<number> {
  try {
    await execute(argv, runtime)
    return 0
  } catch (failure) {
    if (failure instanceof CliUsageError) {
      runtime.output(`错误：${failure.message}`)
      runtime.output(maintenanceUsage)
      return 2
    }
    if (isKnowledgeError(failure)) {
      runtime.output(`错误：${failure.message}`)
      return 1
    }
    runtime.output("错误：发布维护失败，请检查数据库配置与操作参数。")
    return 1
  }
}
