export async function serializeWord(
  exporter: () => Promise<Blob>,
  errorCount: () => number,
  timeoutMs = 60000,
): Promise<Blob> {
  const before = errorCount()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const blob = await Promise.race([exporter(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Word 文档导出超时，当前编辑已保留，请重试。")), timeoutMs)
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
