import assert from "node:assert/strict"

/** Durable references only: pending writes/uploads/exports can legitimately lack bytes. */
export function verifyBackupReferences(database, objects) {
  const exists = name => database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const entries = new Map(objects.map(entry => [entry.key, entry]))
  const check = (key, sha256, size) => {
    assert.ok(typeof key === "string" && key.length > 0, "持久对象引用缺少键")
    assert.ok(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256), "持久对象引用摘要无效")
    const object = entries.get(key)
    assert.ok(object, `持久对象引用缺失：${key}`)
    assert.equal(object.sha256, sha256, `持久对象引用摘要不一致：${key}`)
    if (size !== undefined) {
      assert.ok(Number.isSafeInteger(size) && size >= 0, "持久对象引用大小无效")
      assert.equal(object.size, size, `持久对象引用大小不一致：${key}`)
    }
  }
  if (exists("equilens_material_versions")) {
    for (const row of database.prepare("SELECT object_key,sha256,size_bytes FROM equilens_material_versions").all()) check(row.object_key, row.sha256, row.size_bytes)
  }
  if (exists("equilens_project_document_versions")) {
    for (const row of database.prepare("SELECT metadata FROM equilens_project_document_versions").all()) {
      const version = JSON.parse(row.metadata)
      check(version.objectKey, version.sha256, version.size)
    }
  }
  if (exists("equilens_result_exports")) {
    for (const row of database.prepare("SELECT object_key,sha256 FROM equilens_result_exports WHERE state='ready'").all()) check(row.object_key, row.sha256)
  }
}
