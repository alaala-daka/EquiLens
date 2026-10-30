import { BusinessError } from "../projects/errors"
import { parseCollectionLetterValue } from "./validation"

/** `collection-letter-v1` 导出正文：只读所选保存版本，保留 AI 草稿与未发送声明。 */
export const collectionLetterExportTemplate = {
  version: "collection-letter-v1",
  blocksInvalidResult: true,
  paragraphs(raw: unknown): string[] {
    const value = parseCollectionLetterValue(raw)
    if (!value) throw new BusinessError("INVALID_INPUT", "催款函校验未通过。")
    return [`催款函（${value.status === "ready" ? "可复核草稿" : "草稿，待补充"}）`, ...value.paragraphs,
      "本函由服务端按固定模板确定性渲染，未调用模型生成正文，也未自动发送。"]
  },
}
