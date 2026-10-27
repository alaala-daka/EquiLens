import { fork } from "node:child_process"
import { resolve } from "node:path"
import { ReviewError } from "./errors"
import type { ReviewResult } from "./types"
import type { RevisionState, RevisionAudit } from "./revision"

export function renderRevisionInChild(bytes: Buffer, primary: ReviewResult, draft: RevisionState, audit: RevisionAudit, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise((accept, reject) => {
    const child = fork(/* turbopackIgnore: true */ resolve(process.cwd(), "scripts/generated/contract-revision-renderer.mjs"), [], {
      execArgv: ["--max-old-space-size=512"], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { NODE_ENV: "production" },
    })
    let settled = false
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); child.kill()
      if (error) reject(error); else accept(output!)
    }
    const abort = () => finish(new ReviewError("REVIEW_CANCELLED"))
    const timer = setTimeout(() => finish(new ReviewError("REVIEW_REVISION_EXPORT_FAILED")), 60000)
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) { abort(); return }
    child.once("error", () => finish(new ReviewError("REVIEW_REVISION_EXPORT_FAILED")))
    child.once("exit", () => finish(new ReviewError("REVIEW_REVISION_EXPORT_FAILED")))
    child.once("message", value => {
      const result = value as { valid?: boolean; bytes?: string }
      if (result.valid === true && result.bytes && result.bytes.length <= 28 * 1024 * 1024) finish(undefined, Buffer.from(result.bytes, "base64"))
      else finish(new ReviewError("REVIEW_REVISION_EXPORT_FAILED"))
    })
    child.send({ bytes: bytes.toString("base64"), primary, draft, audit }, error => { if (error) finish(new ReviewError("REVIEW_REVISION_EXPORT_FAILED")) })
  })
}
