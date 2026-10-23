export class WordExportTimeout extends Error {
  constructor() { super("Word 文档导出超时，当前编辑已保留，请重新加载后重试。") }
}

// Each canvas owns one serializer. A deadline rejects the caller, but cannot
// cancel the vendor export: keep the lock until that operation actually settles.
export function createWordSerializer(errorCount: () => number, timeoutMs = 60000) {
  let pending = false
  return async (operation: () => Promise<Blob>) => {
    if (pending) throw new Error("Word 文档仍在处理，请稍候或重新加载。")
    pending = true
    return serializeWord(async () => {
      try { return await operation() } finally { pending = false }
    }, errorCount, timeoutMs)
  }
}

export async function serializeWord(
  exporter: () => Promise<Blob>,
  errorCount: () => number,
  timeoutMs = 60000,
): Promise<Blob> {
  const before = errorCount()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const blob = await Promise.race([exporter(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WordExportTimeout()), timeoutMs)
    })])
    // The engine can emit an exception and return the original bytes as fallback.
    if (errorCount() !== before || !blob?.size) throw new Error("Word 文档导出失败，当前编辑已保留，请重试。")
    return blob
  } finally { clearTimeout(timer) }
}
export function editorText(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const node = value as { type?: string; text?: string; content?: unknown[] }
  if (node.type === "text") return node.text ?? ""
  return node.content?.map(editorText).join("") ?? ""
}
