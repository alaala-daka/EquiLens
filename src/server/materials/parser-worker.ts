import { parseMaterial, ParseFailure } from "./parse"
import type { MaterialFormat } from "./types"

process.once("message", (input: { bytes: Uint8Array; format: MaterialFormat }) => {
  try {
    const result = parseMaterial({ bytes: new Uint8Array(input.bytes), format: input.format })
    process.send?.({ ok: true, result }, () => process.exit(0))
  } catch (error) {
    process.send?.({ ok: false, code: error instanceof ParseFailure ? error.code : "INVALID_SOURCE" }, () => process.exit(0))
  }
})
