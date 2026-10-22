import { parseDocxBytes } from "./document"

process.once("message", (message: { bytes: string }) => {
  try {
    const paragraphs = parseDocxBytes(Buffer.from(message.bytes, "base64"))
    process.send?.({ valid: true, paragraphs }, () => process.exit(0))
  } catch {
    process.send?.({ valid: false }, () => process.exit(0))
  }
})
