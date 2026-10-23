import { createHash, randomUUID } from "node:crypto"
import { DOCX_TYPE, EDITOR_VERSION, documentTitle, type DocumentRecord, type OpenDocument, type Revision } from "../../lib/documents/types"
import type { Connection, Database, Row } from "../database/connection"
import type { RetentionConsent } from "../../lib/documents/session-types"
import { StoreError, sessionTransaction } from "./errors"
import type { DocumentSessionRepository } from "./session-repository"

export { StoreError } from "./errors"
const conflict = () => new StoreError(409, "文档已在其他页面保存。请将当前编辑另存为新文档。", "REVISION_CONFLICT")
export type SaveInput = { documentId: string; baseRevision: string; operationId: string; title: string; prompt: string; blob: Blob }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const metadata = (row: Row) => JSON.parse(String(row.metadata))

export class DocumentRepository {
  constructor(private readonly database: Database, private readonly sessions: DocumentSessionRepository) {}

  list(owner: string): Promise<DocumentRecord[]> {
    return sessionTransaction(this.database, async connection => {
      await this.sessions.guardIn(connection, owner, "read")
      const { rows } = await connection.query("SELECT metadata FROM equilens_documents WHERE owner=$1", [owner])
      return rows.map(row => metadata(row) as DocumentRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
  }

  private async read(connection: Connection, owner: string, id: string): Promise<OpenDocument> {
    const documents = await connection.query("SELECT metadata, current_revision FROM equilens_documents WHERE owner=$1 AND id=$2", [owner, id])
    const document = documents.rows[0] && metadata(documents.rows[0]) as DocumentRecord
    if (!document) throw new StoreError(404, "找不到文档保存版本。")
    const revisions = await connection.query("SELECT metadata, payload FROM equilens_revisions WHERE owner=$1 AND id=$2 AND document_id=$3", [owner, document.currentRevision, id])
    const row = revisions.rows[0]
    if (!row) throw new StoreError(500, "文档保存版本不完整。")
    const bytes = Buffer.from(String(row.payload), "base64")
    const revision = metadata(row) as Omit<Revision, "blob">
    if (hash(bytes) !== revision.hash) throw new StoreError(500, "文档保存版本校验失败。")
    return { document, revision: { ...revision, blob: new Blob([bytes], { type: DOCX_TYPE }) } }
  }

  open(owner: string, id: string) {
    return sessionTransaction(this.database, async connection => {
      await this.sessions.guardIn(connection, owner, "read")
      return this.read(connection, owner, id)
    })
  }

  async create(owner: string, input: { blob: Blob; title: string; source: DocumentRecord["source"]; fileName?: string; prompt: string; copiedFrom?: DocumentRecord["copiedFrom"]; retentionConsent?: RetentionConsent }) {
    const bytes = Buffer.from(await input.blob.arrayBuffer())
    return sessionTransaction(this.database, async connection => {
      await this.sessions.guardIn(connection, owner, input.source === "copy" ? "copy" : "create")
      if (input.source === "copy" && !input.copiedFrom) throw new StoreError(404, "找不到复制来源。")
      if (input.copiedFrom) {
        const { rows } = await connection.query("SELECT id FROM equilens_revisions WHERE owner=$1 AND id=$2 AND document_id=$3", [owner, input.copiedFrom.revisionId, input.copiedFrom.documentId])
        if (!rows.length) throw new StoreError(404, "找不到复制来源。")
      }
      const { createdAt: now } = await this.sessions.confirmCreateIn(connection, owner, input.source, input.retentionConsent)
      const id = randomUUID()
      const revision: Revision = { id: randomUUID(), documentId: id, parentId: null, hash: hash(bytes), blob: input.blob, createdAt: now, editorVersion: EDITOR_VERSION, templateVersion: input.source === "authored" ? "blank-v1" : null }
      const document: DocumentRecord = { id, title: documentTitle(input.title), prompt: input.prompt, source: input.source, copiedFrom: input.copiedFrom, createdAt: now, updatedAt: now, currentRevision: revision.id }
      await connection.query("INSERT INTO equilens_documents(owner,id,current_revision,metadata) VALUES ($1,$2,$3,$4)", [owner, id, revision.id, JSON.stringify({ ...document, ...(input.source === "imported" ? { originalRevision: revision.id, originalFileName: input.fileName } : {}) })])
      await this.insertRevision(connection, owner, revision, bytes)
      return { document, revision }
    })
  }

  private insertRevision(connection: Connection, owner: string, revision: Revision, bytes: Buffer) {
    const { blob: _blob, ...meta } = revision
    void _blob
    return connection.query("INSERT INTO equilens_revisions(owner,id,document_id,metadata,payload) VALUES ($1,$2,$3,$4,$5)", [owner, revision.id, revision.documentId, JSON.stringify(meta), bytes.toString("base64")])
  }

  async save(owner: string, input: SaveInput): Promise<OpenDocument> {
    const bytes = Buffer.from(await input.blob.arrayBuffer())
    const digest = hash(bytes)
    return sessionTransaction(this.database, async connection => {
      await this.sessions.guardIn(connection, owner, "save")
      const current = await this.read(connection, owner, input.documentId)
      const prior = await connection.query("SELECT metadata FROM equilens_revisions WHERE owner=$1 AND id=$2", [owner, input.operationId])
      if (prior.rows.length) {
        if (current.revision.id === input.operationId && current.revision.parentId === input.baseRevision && current.revision.hash === digest && current.document.title === documentTitle(input.title) && current.document.prompt === input.prompt) return current
        throw conflict()
      }
      if (current.revision.id !== input.baseRevision) throw conflict()
      const now = new Date().toISOString()
      const document = { ...current.document, title: documentTitle(input.title), prompt: input.prompt, updatedAt: now, currentRevision: input.operationId }
      const revision: Revision = { id: input.operationId, documentId: input.documentId, parentId: input.baseRevision, blob: input.blob, hash: digest, createdAt: now, editorVersion: EDITOR_VERSION, templateVersion: null }
      const updated = await connection.query("UPDATE equilens_documents SET metadata=$1,current_revision=$2 WHERE owner=$3 AND id=$4 AND current_revision=$5", [JSON.stringify(document), revision.id, owner, document.id, input.baseRevision])
      if (updated.changes !== 1) throw conflict()
      await this.insertRevision(connection, owner, revision, bytes)
      return { document, revision }
    })
  }
}
