import { createHash, randomUUID } from "node:crypto"
import { paragraphsFromString } from "./document"
import { ReviewError } from "./errors"
import type { LoadedPack, Paragraph, ReviewContext, ReviewResult } from "./types"

export type ReviewInput = {
  documentText?: string
  paragraphs?: Paragraph[]
  documentTitle?: string
  documentVersionId?: string
  parseSnapshotId?: string
  complete?: boolean
  context?: ReviewContext
  mode?: "published" | "debug"
}

/** 在任何异步操作前固定任务输入；文档版本由后端指定，模型不能更改。 */
export function prepareReviewInput(input: ReviewInput, suppliedPack: LoadedPack, modelName: string, callsUsed = 0) {
  if ((input.complete !== undefined && typeof input.complete !== "boolean") ||
      (input.context !== undefined && (!input.context || typeof input.context !== "object" || Array.isArray(input.context))) ||
      [input.documentTitle, input.documentVersionId, input.parseSnapshotId].some(value =>
        value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 200)) ||
      (input.documentText !== undefined && (typeof input.documentText !== "string" || input.paragraphs !== undefined))) {
    throw new ReviewError("REVIEW_INPUT_INVALID")
  }
  const pack = structuredClone(suppliedPack)
  const paragraphs = structuredClone(input.paragraphs ?? paragraphsFromString(input.documentText ?? ""))
  if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some(item => !item ||
      !Number.isSafeInteger(item.index) || item.index < 0 || typeof item.text !== "string" || !item.text.trim()) ||
      new Set(paragraphs.map(item => item.index)).size !== paragraphs.length) throw new ReviewError("REVIEW_INPUT_INVALID")
  const text = paragraphs.map(item => item.text).join("\n")
  if (text.length > 100000 || (input.documentText?.length ?? 0) > 100000) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
  const context = { ...input.context }
  if (Object.values(context).some(value => typeof value !== "string" || !value.trim() || value.length > 200)) throw new ReviewError("REVIEW_INPUT_INVALID")
  const mode = input.mode ?? "published"
  if (mode !== "published" && mode !== "debug") throw new ReviewError("REVIEW_INPUT_INVALID")
  const result: ReviewResult = {
    schemaVersion: 1, reviewId: randomUUID(), createdAt: new Date().toISOString(), status: "failed", mode,
    warnings: [...pack.warnings], errors: [], callsUsed,
    input: {
      textSha256: createHash("sha256").update(text).digest("hex"),
      documentVersionId: input.documentVersionId, parseSnapshotId: input.parseSnapshotId,
      complete: input.complete !== false, context,
    },
    documentTitle: input.documentTitle ?? "未命名合同", packVersion: pack.manifest.version,
    paragraphs, findings: [], rejected: [], notLocated: [], coverage: [], usage: null, model: modelName,
  }
  if (mode === "debug") result.warnings.unshift("调试结果：使用未核对材料，仅用于开发联调，不形成正式法律结论。")
  if (!result.input.complete) result.warnings.push("输入解析不完整；不能确认无问题或条款缺失。")
  return { pack, paragraphs, context, result }
}
