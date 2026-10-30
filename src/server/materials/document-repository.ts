import type { Database } from "../database/connection"
import { BusinessError } from "../projects/errors"

export type ProjectDocument = {
  id: string; projectId: string; title: string; prompt?: string; currentVersionId: string
  createdAt: string; updatedAt: string; materialId: string; materialVersionId: string
  copiedFrom: { documentId: string; versionId: string } | null
}
export type ProjectDocumentVersion = {
  id: string; projectId: string; documentId: string; parentId: string | null
  sha256: string; objectKey: string; size: number; createdAt: string
  operationId: string; inputHash: string; editorVersion: string
}
const conflict = () => new BusinessError("CONFLICT", "文档版本已更改，请另存为新文档。")

export class ProjectDocumentRepository {
  constructor(private readonly database: Database) {}
  async beginWrite(input: { id: string; projectId: string; objectKey: string; materialId: string; materialVersionId: string; retentionUntil: string }): Promise<void> {
    await this.database.transaction(c => c.query("INSERT INTO equilens_project_document_writes(id,project_id,object_key,provenance,state,created_at) VALUES($1,$2,$3,$4,$5,$6)", [input.id, input.projectId, input.objectKey, JSON.stringify(input), "pending", new Date().toISOString()]).then(() => {}))
  }
  async completeWrite(id: string): Promise<void> {
    await this.database.transaction(c => c.query("UPDATE equilens_project_document_writes SET state=$1 WHERE id=$2", ["ready", id]).then(() => {}))
  }
  async pendingWrites(before: string, limit: number): Promise<{ id: string; objectKey: string; projectId: string }[]> {
    return this.database.transaction(async c => (await c.query("SELECT id,object_key,project_id FROM equilens_project_document_writes WHERE state=$1 AND created_at<$2 ORDER BY created_at LIMIT $3", ["pending", before, Math.max(1, Math.min(100, limit))])).rows.map(r => ({ id: String(r.id), objectKey: String(r.object_key), projectId: String(r.project_id) })))
  }
  async objectReferenced(projectId: string, objectKey: string): Promise<boolean> {
    return this.database.transaction(async c => (await c.query("SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1", [projectId])).rows.some(r => (JSON.parse(String(r.metadata)) as ProjectDocumentVersion).objectKey === objectKey))
  }
  async list(projectId: string): Promise<ProjectDocument[]> {
    return this.database.transaction(async c => (await c.query("SELECT metadata FROM equilens_project_documents WHERE project_id=$1", [projectId])).rows.map(r => JSON.parse(String(r.metadata))))
  }
  async find(projectId: string, id: string): Promise<ProjectDocument | null> {
    return this.database.transaction(async c => {
      const { rows } = await c.query("SELECT metadata FROM equilens_project_documents WHERE project_id=$1 AND id=$2", [projectId, id])
      return rows.length ? JSON.parse(String(rows[0].metadata)) : null
    })
  }
  async version(projectId: string, documentId: string, id: string): Promise<ProjectDocumentVersion | null> {
    return this.database.transaction(async c => {
      const { rows } = await c.query("SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1 AND document_id=$2 AND id=$3", [projectId, documentId, id])
      return rows.length ? JSON.parse(String(rows[0].metadata)) : null
    })
  }
  async operation(projectId: string, documentId: string, operationId: string): Promise<ProjectDocumentVersion | null> {
    return this.database.transaction(async c => {
      const { rows } = await c.query("SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1 AND document_id=$2 AND operation_id=$3", [projectId, documentId, operationId])
      return rows.length ? JSON.parse(String(rows[0].metadata)) : null
    })
  }
  async create(document: ProjectDocument, version: ProjectDocumentVersion): Promise<ProjectDocumentVersion> {
    return this.database.transaction(async c => {
      const existing = await c.query("SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1 AND document_id=$2 AND operation_id=$3", [document.projectId, document.id, version.operationId])
      if (existing.rows.length) {
        const saved: ProjectDocumentVersion = JSON.parse(String(existing.rows[0].metadata))
        if (saved.inputHash !== version.inputHash) throw conflict()
        return saved
      }
      await c.query("INSERT INTO equilens_project_documents(project_id,id,current_version_id,metadata) VALUES($1,$2,$3,$4)", [document.projectId, document.id, version.id, JSON.stringify(document)])
      await c.query("INSERT INTO equilens_project_document_versions(project_id,id,document_id,operation_id,input_hash,metadata) VALUES($1,$2,$3,$4,$5,$6)", [version.projectId, version.id, document.id, version.operationId, version.inputHash, JSON.stringify(version)])
      return version
    })
  }
  async save(document: ProjectDocument, version: ProjectDocumentVersion, baseVersionId: string): Promise<ProjectDocumentVersion> {
    return this.database.transaction(async c => {
      const existing = await c.query("SELECT metadata FROM equilens_project_document_versions WHERE project_id=$1 AND document_id=$2 AND operation_id=$3", [document.projectId, document.id, version.operationId])
      if (existing.rows.length) {
        const saved: ProjectDocumentVersion = JSON.parse(String(existing.rows[0].metadata))
        if (saved.inputHash !== version.inputHash || saved.parentId !== baseVersionId) throw conflict()
        return saved
      }
      const updated = await c.query("UPDATE equilens_project_documents SET current_version_id=$1,metadata=$2 WHERE project_id=$3 AND id=$4 AND current_version_id=$5", [version.id, JSON.stringify(document), document.projectId, document.id, baseVersionId])
      if (updated.changes !== 1) throw conflict()
      await c.query("INSERT INTO equilens_project_document_versions(project_id,id,document_id,operation_id,input_hash,metadata) VALUES($1,$2,$3,$4,$5,$6)", [version.projectId, version.id, document.id, version.operationId, version.inputHash, JSON.stringify(version)])
      return version
    })
  }
}
