import { fork } from "node:child_process"
import { resolve } from "node:path"
import { MATERIAL_LIMITS } from "./parse"
import type { MaterialFormat, ParsedMaterial } from "./types"

export class ParserProcessError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** The worker receives only material bytes; inherited credentials and Node options are excluded. */
export function parseInSubprocess(input: { bytes: Uint8Array; format: MaterialFormat }, options: {
  signal?: AbortSignal
  timeoutMs?: number
  workerPath?: string
} = {}): Promise<ParsedMaterial> {
  if (options.signal?.aborted) return Promise.reject(new ParserProcessError("PARSE_ABORTED"))
  if (!input.bytes.length || input.bytes.length > MATERIAL_LIMITS.fileBytes) return Promise.reject(new ParserProcessError("LIMIT_EXCEEDED"))
  const workerPath = options.workerPath ?? /* turbopackIgnore: true */ resolve(process.cwd(), "scripts/generated/material-parser.cjs")
  return new Promise((resolveResult, reject) => {
    const child = fork(/* turbopackIgnore: true */ workerPath, [], {
      execArgv: ["--max-old-space-size=512"],
      env: { NODE_ENV: "production" },
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    let settled = false
    const finish = (error?: Error, result?: ParsedMaterial) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      child.kill("SIGKILL")
      if (error) reject(error)
      else resolveResult(result!)
    }
    const abort = () => finish(new ParserProcessError("PARSE_ABORTED"))
    const timer = setTimeout(() => finish(new ParserProcessError("PARSE_TIMEOUT")), Math.min(options.timeoutMs ?? 60_000, 60_000))
    options.signal?.addEventListener("abort", abort, { once: true })
    child.once("error", () => finish(new ParserProcessError("PARSE_WORKER_FAILED")))
    child.once("exit", () => finish(new ParserProcessError("PARSE_WORKER_FAILED")))
    child.once("message", (message: { ok: boolean; result?: ParsedMaterial; code?: string }) => {
      if (message.ok && message.result) finish(undefined, message.result)
      else finish(new ParserProcessError(message.code ?? "PARSE_WORKER_FAILED"))
    })
    if (options.signal?.aborted) abort()
    else child.send(input, error => { if (error) finish(new ParserProcessError("PARSE_WORKER_FAILED")) })
  })
}
