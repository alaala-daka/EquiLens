import type { Paragraph } from "./types"

/**
 * 条款块：审查取材的单位。
 * 段落编号仍指向解析结果，引文校验不受切块影响。
 */
export type Segment = {
  id: string
  title: string
  indexes: number[]
  text: string
  chars: number
}

/** 条款标题：第X条/章/节、一、、（一）、1. / 1.1 等常见编号。 */
const HEADING = /^(第[零一二三四五六七八九十百千0-9]+[条章节]|[一二三四五六七八九十]+、|[（(][一二三四五六七八九十]+[）)]|[0-9]+(\.[0-9]+)*[.、\s])/

/** 单块正文上限；超过时按段落边界再切，绝不切段落内部。 */
export const DEFAULT_MAX_CHARS = 1200

export function isHeading(text: string): boolean {
  return HEADING.test(text.trim())
}

function titleOf(group: Paragraph[]): string {
  const first = group[0].text.trim()
  const from = group[0].index
  const to = group[group.length - 1].index
  // 短首段（文档标题等）直接用作块名；正文片段长，改用编号范围。
  if (isHeading(first) || first.length <= 30) {
    return first.length > 24 ? first.slice(0, 24) + "…" : first
  }
  return "段 " + from + "–" + to
}

function makeSegment(group: Paragraph[], position: number): Segment {
  const indexes = group.map(item => item.index)
  const text = group.map(item => "[" + item.index + "] " + item.text).join("\n")
  return {
    id: "s" + position,
    title: titleOf(group),
    indexes,
    text,
    chars: text.length,
  }
}

/**
 * 把段落切成条款块。保证：所有段落恰好落在一块内，顺序不变，不切段落内部。
 * 无编号的文档退化为按段落边界累积到上限再切。
 */
export function buildSegments(paragraphs: Paragraph[], maxChars = DEFAULT_MAX_CHARS): Segment[] {
  if (!paragraphs.length) return []
  const groups: Paragraph[][] = []
  let current: Paragraph[] = []
  for (const paragraph of paragraphs) {
    if (isHeading(paragraph.text) && current.length) {
      groups.push(current)
      current = [paragraph]
      continue
    }
    current.push(paragraph)
  }
  if (current.length) groups.push(current)

  const segments: Segment[] = []
  for (const group of groups) {
    let batch: Paragraph[] = []
    let chars = 0
    for (const paragraph of group) {
      const size = paragraph.text.length + 8
      if (batch.length && chars + size > maxChars) {
        segments.push(makeSegment(batch, segments.length))
        batch = []
        chars = 0
      }
      batch.push(paragraph)
      chars += size
    }
    if (batch.length) segments.push(makeSegment(batch, segments.length))
  }
  return segments
}

/** 全文目录：给模型看的索引，也是"看过哪些条款"的记录。 */
export function buildOutline(segments: Segment[]): string {
  return segments
    .map(segment => segment.title + "（段 " + segment.indexes[0] + "–" + segment.indexes[segment.indexes.length - 1] + "）")
    .join("\n")
}

/** 取出若干段落的原文，用于定向取材。 */
export function collectParagraphs(paragraphs: Paragraph[], indexes: Iterable<number>): Paragraph[] {
  const wanted = new Set(indexes)
  return paragraphs.filter(item => wanted.has(item.index))
}

/**
 * 命中段落所在的块，连同前后各一块。相邻块用于跨条约定，避免只给半句话。
 */
export function expandSegments(segments: Segment[], hitIndexes: Iterable<number>): Segment[] {
  const wanted = new Set(hitIndexes)
  const picked = new Set<number>()
  segments.forEach((segment, position) => {
    if (!segment.indexes.some(index => wanted.has(index))) return
    picked.add(position)
    if (position > 0) picked.add(position - 1)
    if (position + 1 < segments.length) picked.add(position + 1)
  })
  return [...picked].sort((left, right) => left - right).map(position => segments[position])
}
