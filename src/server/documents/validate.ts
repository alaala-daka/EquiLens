import { fork } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { StoreError } from "./repository"

const missing = () => new StoreError(503, "文档校验组件未生成，请运行 pnpm prepare:contract 后重试。")
const unavailable = () => new StoreError(503, "文档校验暂时不可用。")

let running = false
export async function validateUpload(bytes: Buffer): Promise<void> {
  if (running) throw new StoreError(429, "文档正在处理中，请稍后重试。")
  running = true
  try {
    const validatorPath = /* turbopackIgnore: true */ resolve(process.cwd(), "scripts/generated/docx-validator.mjs")
    if (!existsSync(validatorPath)) throw missing()
    await new Promise<void>((accept, reject) => {
      const child = fork(validatorPath, [], { execArgv: ["--max-old-space-size=192"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { NODE_ENV: "production" }, windowsHide: true })
      let settled = false
      let stderr = ""
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", chunk => { if (stderr.length < 2000) stderr += chunk })
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        if (error) reject(error); else accept()
      }
      const timer = setTimeout(() => finish(new StoreError(422, "文档校验超时，请缩减文档后重试。")), 15000)
      child.once("message", message => finish((message as { valid?: boolean }).valid === true ? undefined : new StoreError(422, "Word 文件无效或包含不支持的内容。")))
      child.once("error", () => finish(unavailable()))
      child.once("exit", code => {
        if (settled) return
        console.error(stderr ? `Document validator exited with ${code}: ${stderr.trim().slice(0, 500)}` : `Document validator exited with ${code} before reporting a result`)
        finish(unavailable())
      })
      child.send({ bytes: bytes.toString("base64") }, error => { if (error) finish(unavailable()) })
    })
  } finally { running = false }
}
