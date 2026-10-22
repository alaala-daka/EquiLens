import assert from "node:assert/strict"
import { test } from "node:test"
import type { DocumentRecord } from "./types"
import { selectDocuments, formatDocumentUpdatedAt } from "./list-view"

const record = (id: string, title: string, updatedAt: string): DocumentRecord => ({
  id, title, updatedAt, createdAt: updatedAt,
  source: "authored", prompt: "", currentRevision: `${id}-revision`,
})

test("UI-02/03: trim, case-insensitive title search and stable instant order", () => {
  const rows = [
    record("b", "安装合同 Alpha", "2026-10-22T08:00:00Z"),
    record("a", "安装合同 ALPHA", "2026-10-22T16:00:00+08:00"),
    record("c", "补充协议", "2026-10-22T09:00:00Z"),
  ]
  rows[2].prompt = "安装合同 alpha"
  assert.deepEqual(selectDocuments(rows, " alpha ").map(row => row.id), ["a", "b"])
  assert.deepEqual(selectDocuments(rows, "安装").map(row => row.id), ["a", "b"])
  assert.deepEqual(selectDocuments(rows, " ").map(row => row.id), ["c", "a", "b"])
  assert.deepEqual(selectDocuments(rows, "不存在"), [])
  assert.deepEqual(rows.map(row => row.id), ["b", "a", "c"])
})

test("UI-02: show the saved instant in Asia/Shanghai, including day rollover", () => {
  assert.equal(formatDocumentUpdatedAt("2026-10-22T16:05:00Z"), "2026-10-23 00:05")
  assert.equal(formatDocumentUpdatedAt("invalid"), "时间不可用")
})
