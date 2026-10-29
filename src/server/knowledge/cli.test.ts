import assert from "node:assert/strict"
import { test } from "node:test"
import { runMaintenanceCli, type MaintenanceCliRuntime } from "./cli"
import {
  artifactId, disabledOperatorId, domainReviewer, fixedVerifiedAt, memberAccountId, operatorAccountId, scene, setupKnowledge,
  syntheticContent,
} from "./test-fixtures"
import { createMaintenanceService } from "./service"

type Fixture = Awaited<ReturnType<typeof setupKnowledge>>

function runtimeFor(fixture: Fixture, files: Map<string, string> = new Map()): { runtime: MaintenanceCliRuntime; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    runtime: {
      service: createMaintenanceService(fixture.database, fixture.env, { now: () => fixture.now }),
      env: fixture.env,
      readFile: async path => {
        const content = files.get(path)
        if (content === undefined) throw new Error("missing fixture file")
        return content
      },
      output: line => lines.push(line),
    },
  }
}

async function cli(fixture: Fixture, argv: string[], files: Map<string, string> = new Map()) {
  const { runtime, lines } = runtimeFor(fixture, files)
  const code = await runMaintenanceCli(argv, runtime)
  return { code, output: lines.join("\n"), lines }
}

test("C6 CLI: validate reports the content digest and publish blockers without writing", async () => {
  const fixture = await setupKnowledge()
  try {
    const files = new Map([["pack.json", syntheticContent()]])
    const checked = await cli(fixture, ["validate", "--kind", "rules", "--scene", scene, "--file", "pack.json"], files)
    assert.equal(checked.code, 0)
    assert.match(checked.output, /sha256=[a-f0-9]{64}/)
    assert.match(checked.output, /发布阻塞/)
    const publishable = await cli(fixture, ["validate", "--kind", "rules", "--scene", scene, "--file", "pack.json"], new Map([
      ["pack.json", syntheticContent({ status: "已发布", ruleStatus: "已发布", sourceStatus: "已发布" })],
    ]))
    assert.equal(publishable.code, 0)
    assert.match(publishable.output, /可发布/)
    assert.equal((await fixture.service.list()).length, 0)
  } finally { await fixture.close() }
})

test("C6 CLI: validate maps unreadable files and invalid content to a refused command (exit 1)", async () => {
  const fixture = await setupKnowledge()
  try {
    const missing = await cli(fixture, ["validate", "--kind", "rules", "--scene", scene, "--file", "missing.json"])
    assert.equal(missing.code, 1)
    assert.match(missing.output, /无法读取发布内容文件/)
    const pathContent = await cli(fixture, ["validate", "--kind", "rules", "--scene", scene, "--file", "pack.json"],
      new Map([["pack.json", JSON.stringify({ ...JSON.parse(syntheticContent()), ruleFiles: ["rules/a.json"] })]]))
    assert.equal(pathContent.code, 1)
    assert.match(pathContent.output, /文件引用/)
  } finally { await fixture.close() }
})

test("C6 CLI: submit -> list -> show -> publish -> disable round trip with redacted output", async () => {
  const fixture = await setupKnowledge()
  try {
    const files = new Map([["pack.json", syntheticContent({ status: "已发布", ruleStatus: "已发布", sourceStatus: "已发布" })]])
    const submitted = await cli(fixture, [
      "submit", "--kind", "rules", "--artifact", artifactId, "--scene", scene,
      "--file", "pack.json", "--operator", operatorAccountId,
    ], files)
    assert.equal(submitted.code, 0)
    assert.match(submitted.output, /已提交：rules\/synthetic-contract-review/)
    assert.match(submitted.output, /\[草稿\]/)
    const summaries = await fixture.service.list({ kind: "rules", artifactId })
    const version = summaries[0].latestVersion!
    assert.equal(version.state, "draft")

    const listed = await cli(fixture, ["list", "--kind", "rules"])
    assert.equal(listed.code, 0)
    assert.match(listed.output, /rules\/synthetic-contract-review/)
    assert.match(listed.output, /\[草稿\]/)
    assert.equal(listed.output.includes("合成测试要求"), false)
    assert.equal(listed.output.includes("合成测试来源正文"), false)
    assert.equal(listed.output.includes("C:\\"), false)

    const shown = await cli(fixture, ["show", "--version", version.versionId])
    assert.equal(shown.code, 0)
    assert.match(shown.output, /内容：规则包=/)
    assert.equal(shown.output.includes("合成测试要求"), false)
    assert.equal(shown.output.includes("合成测试来源正文"), false)

    const wrongSha = await cli(fixture, [
      "publish", "--version", version.versionId, "--operator", operatorAccountId, "--reviewer", domainReviewer,
      "--verified-at", fixedVerifiedAt, "--expected-sha", "0".repeat(64), "--evidence", "合成核对证据",
    ])
    assert.equal(wrongSha.code, 1)
    assert.match(wrongSha.output, /期望摘要/)

    const published = await cli(fixture, [
      "publish", "--version", version.versionId, "--operator", operatorAccountId, "--reviewer", domainReviewer,
      "--verified-at", fixedVerifiedAt, "--expected-sha", version.sha256, "--evidence", "合成核对证据：仅机制验证",
    ])
    assert.equal(published.code, 0)
    assert.match(published.output, /已发布：rules\/synthetic-contract-review/)
    assert.match(published.output, /\[已发布\]/)
    assert.match(published.output, /核对人：domain-reviewer/)

    const filtered = await cli(fixture, ["list", "--kind", "rules", "--state", "published"])
    assert.equal(filtered.code, 0)
    assert.match(filtered.output, /\[已发布\]/)

    const disabled = await cli(fixture, [
      "disable", "--version", version.versionId, "--operator", operatorAccountId, "--reason", "合成测试停用",
    ])
    assert.equal(disabled.code, 0)
    assert.match(disabled.output, /已停用/)
    assert.match(disabled.output, /合成测试停用/)
    const afterDisable = await cli(fixture, ["show", "--kind", "rules", "--artifact", artifactId])
    assert.equal(afterDisable.code, 0)
    assert.match(afterDisable.output, /\[已停用\]/)
  } finally { await fixture.close() }
})

test("C6 CLI: pending verification can be submitted with an allowlisted reviewer", async () => {
  const fixture = await setupKnowledge()
  try {
    const submitted = await cli(fixture, [
      "submit", "--kind", "rules", "--artifact", artifactId, "--scene", scene, "--file", "pack.json",
      "--operator", operatorAccountId, "--reviewer", domainReviewer,
    ], new Map([["pack.json", syntheticContent()]]))
    assert.equal(submitted.code, 0)
    assert.match(submitted.output, /\[待核对\]/)
    assert.match(submitted.output, /核对人：domain-reviewer/)
  } finally { await fixture.close() }
})

test("C6 CLI: fake-signoff guards and invalid arguments are refused with fixed messages", async () => {
  const fixture = await setupKnowledge()
  try {
    const files = new Map([["pack.json", syntheticContent({ status: "已发布", ruleStatus: "已发布", sourceStatus: "已发布" })]])
    const member = await cli(fixture, [
      "submit", "--kind", "rules", "--artifact", artifactId, "--scene", scene, "--file", "pack.json", "--operator", memberAccountId,
    ], files)
    assert.equal(member.code, 1)
    assert.match(member.output, /操作者必须是现有且启用的超级管理员/)
    assert.equal(member.output.includes("SQL"), false)

    const disabled = await cli(fixture, [
      "submit", "--kind", "rules", "--artifact", artifactId, "--scene", scene, "--file", "pack.json", "--operator", disabledOperatorId,
    ], files)
    assert.equal(disabled.code, 1)

    const unknownFlag = await cli(fixture, ["list", "--bogus", "x"])
    assert.equal(unknownFlag.code, 2)
    assert.match(unknownFlag.output, /用法/)

    const missing = await cli(fixture, ["publish", "--version", "00000000-0000-4000-8000-000000000001"])
    assert.equal(missing.code, 2)

    const pathArtifact = await cli(fixture, ["list", "--kind", "rules", "--artifact", "../etc/passwd"])
    assert.equal(pathArtifact.code, 1, "path-shaped artifact ids are refused by the content guard")
    assert.match(pathArtifact.output, /制品标识无效/)
  } finally { await fixture.close() }
})

test("C6 CLI: unexpected internal failures map to a generic message without stack traces", async () => {
  const lines: string[] = []
  const code = await runMaintenanceCli(["list"], {
    service: {
      list: async () => { throw new Error("SQLITE_ERROR: secret database path C:\\data\\equilens.sqlite") },
    } as unknown as MaintenanceCliRuntime["service"],
    env: {},
    readFile: async () => "",
    output: line => lines.push(line),
  })
  assert.equal(code, 1)
  assert.match(lines.join("\n"), /发布维护失败/)
  assert.equal(lines.join("\n").includes("SQLITE_ERROR"), false)
  assert.equal(lines.join("\n").includes("C:\\data"), false)
})
