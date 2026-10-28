import { parseDocxBytes } from "./document"

process.once("message", (message: { bytes: string }) => {
  try {
    const parsed = parseDocxBytes(Buffer.from(message.bytes, "base64"))
    process.send?.({ valid: true, paragraphs: parsed.paragraphs, coverage: parsed.coverage }, () => process.exit(0))
  } catch {
    process.send?.({ valid: false }, () => process.exit(0))
  }
})
