import type { Finding } from "./types"

/**
 * 主审条目是否带有实质检查范围。
 * 后端为未答必检项补录的占位项没有该字段，空数组同样不代表实际检查过正文。
 */
export function hasCheckedRange(finding: Pick<Finding, "checkedParagraphIndexes">): boolean {
  return (finding.checkedParagraphIndexes?.length ?? 0) > 0
}
