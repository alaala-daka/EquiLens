export type DocumentStructures = {
  images: number
  headerFooterRefs: number
  fields: { simple: number; complex: number }
  revisions: { insertions: number; deletions: number; moves: number; formatChanges: number }
  textboxes: number
  comments: number
  notes: number
  contentControls: number
  mergedCells: number
}

export type EditorStructureCounts = {
  images: number
  revisions: number
  comments: number
  notes: number
  textboxes: number
  mergedCells: number
}

export type DocxInspection = { text: string; structures: DocumentStructures }
export type ExportExpectation = { text: string; structures: EditorStructureCounts }

export function emptyStructures(): DocumentStructures {
  return {
    images: 0, headerFooterRefs: 0, fields: { simple: 0, complex: 0 },
    revisions: { insertions: 0, deletions: 0, moves: 0, formatChanges: 0 },
    textboxes: 0, comments: 0, notes: 0, contentControls: 0, mergedCells: 0,
  }
}

export function emptyCounts(): EditorStructureCounts {
  return { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 }
}

const labels: Record<keyof EditorStructureCounts, string> = {
  images: "图片", revisions: "修订标记", comments: "批注", notes: "脚注引用", textboxes: "文本框", mergedCells: "合并单元格",
}

export function countComparable(structures: DocumentStructures): EditorStructureCounts {
  return {
    images: structures.images,
    revisions: structures.revisions.insertions + structures.revisions.deletions + structures.revisions.moves + structures.revisions.formatChanges,
    comments: structures.comments,
    notes: structures.notes,
    textboxes: structures.textboxes,
    mergedCells: structures.mergedCells,
  }
}

// 导出字节不得少于编辑快照：少即为导出丢内容。正文按同一提取契约精确相等。
export function compareExport(actual: DocxInspection, expected: ExportExpectation): void {
  if (actual.text !== expected.text) throw new Error("导出正文与编辑内容不一致，此次结果未保存，请重试。")
  const counts = countComparable(actual.structures)
  const lost = (Object.keys(expected.structures) as (keyof EditorStructureCounts)[]).filter(key => counts[key] < expected.structures[key])
  if (lost.length) throw new Error(`导出结果与编辑内容不一致（${lost.map(key => labels[key]).join("、")}未保留），此次结果未保存，请重试。`)
}
