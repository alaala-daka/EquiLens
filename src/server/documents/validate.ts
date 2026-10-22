import { fork } from "node:child_process"
import { resolve } from "node:path"
import { StoreError } from "./repository"

let running = false
export async function validateUpload(bytes: Buffer): Promise<void> {
  if (running) throw new StoreError(429, "文档正在处理中，请稍后重试。")
  running = true
  try {
    await new Promise<void>((accept, reject) => {
      const child = fork(/* turbopackIgnore: true */ resolve(process.cwd(), "scripts/generated/docx-validator.mjs"), [], { execArgv: ["--max-old-space-size=192"], stdio: ["ignore", "ignore", "ignore", "ipc"], env: { NODE_ENV: "production" }, windowsHide: true })
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        if (error) reject(error); else accept()
      }
      const timer = setTimeout(() => finish(new StoreError(422, "文档校验超时，请缩减文档后重试。")), 15000)
      child.once("message", message => finish((message as { valid?: boolean }).valid === true ? undefined : new StoreError(422, "Word 文件无效或包含不支持的内容。")))
      child.once("error", () => finish(new StoreError(503, "文档校验暂时不可用。")))
      child.once("exit", () => finish(new StoreError(422, "文档校验失败。")))
      child.send({ bytes: bytes.toString("base64") }, error => { if (error) finish(new StoreError(503, "文档校验暂时不可用。")) })
    })
  } finally { running = false }
}
