import { validateDocxBytes } from "../../lib/documents/docx"

process.once("message", (message: { bytes: string }) => {
  try { validateDocxBytes(Buffer.from(message.bytes, "base64")); process.send?.({ valid: true }, () => process.exit(0)) }
  catch { process.send?.({ valid: false }, () => process.exit(0)) }
})
