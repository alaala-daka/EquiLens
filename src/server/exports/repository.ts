import type { Database, Row } from "../database/connection"
import { BusinessError } from "../projects/errors"

export class ExportRepository {
  constructor(readonly database: Database) {}
  async list(projectId: string, resultId: string) {
    return this.database.transaction(async c => (await c.query("SELECT * FROM equilens_result_exports WHERE project_id=$1 AND result_id=$2 AND state='ready' ORDER BY created_at,id",[projectId,resultId])).rows)
  }
  async get(projectId: string, resultId: string, exportId: string) {
    const row = await this.database.transaction(async c => (await c.query("SELECT * FROM equilens_result_exports WHERE project_id=$1 AND result_id=$2 AND id=$3 AND state='ready'",[projectId,resultId,exportId])).rows[0])
    if (!row) throw new BusinessError("NOT_FOUND","找不到该导出。")
    return row
  }
  async insert(row: Row) {
    if (row.state !== "pending" || row.purpose !== "result-export" || !Number.isFinite(Date.parse(String(row.retention_until)))) throw new BusinessError("INVALID_INPUT","导出意图无效。")
    const columns = ["state","purpose","retention_until","id","project_id","result_id","version_id","result_sha256","sha256","object_key","format","template_version","render_version","snapshot_json","supersedes_id","created_by","created_at"]
    await this.database.transaction(async c => { await c.query(`INSERT INTO equilens_result_exports(${columns.join(",")}) VALUES(${columns.map((_,i) => `$${i+1}`).join(",")})`,columns.map(key => row[key] === null ? null : String(row[key]))) })
  }
  async pending(limit = 10) {
    return this.database.transaction(async c => (await c.query("SELECT * FROM equilens_result_exports WHERE state='pending' ORDER BY cleanup_attempts,created_at,id LIMIT $1",[Math.max(1,Math.min(100,Math.floor(limit) || 10))])).rows)
  }
  async aborted(limit = 10) {
    return this.database.transaction(async c => (await c.query("SELECT * FROM equilens_result_exports WHERE state='aborted' ORDER BY cleanup_attempts,created_at,id LIMIT $1",[Math.max(1,Math.min(100,Math.floor(limit) || 10))])).rows)
  }
  async createReady(projectId: string, exportId: string) {
    return this.transition(projectId,exportId,"ready")
  }
  async clear(projectId: string, exportId: string) {
    await this.database.transaction(async c => { await c.query("UPDATE equilens_result_exports SET state='cleared' WHERE project_id=$1 AND id=$2 AND state='aborted'",[projectId,exportId]) })
  }
  async attempted(projectId: string, exportId: string) {
    await this.database.transaction(async c => { await c.query("UPDATE equilens_result_exports SET cleanup_attempts=cleanup_attempts+1,cleanup_attempted_at=$1 WHERE project_id=$2 AND id=$3 AND state IN ('pending','aborted')",[new Date().toISOString(),projectId,exportId]) })
  }
  async abort(projectId: string, exportId: string) {
    return this.transition(projectId,exportId,"aborted")
  }
  private async transition(projectId: string, exportId: string, state: "ready" | "aborted") {
    await this.database.transaction(async c => {
      const row = (await c.query("SELECT state FROM equilens_result_exports WHERE project_id=$1 AND id=$2",[projectId,exportId])).rows[0]
      if (!row) throw new BusinessError("NOT_FOUND","找不到该导出。")
      if (row.state === state) return
      if (row.state !== "pending") throw new BusinessError("CONFLICT","导出状态已变化。")
      const updated = await c.query("UPDATE equilens_result_exports SET state=$1 WHERE project_id=$2 AND id=$3 AND state='pending'",[state,projectId,exportId])
      if (updated.changes !== 1) throw new BusinessError("CONFLICT","导出状态已变化。")
    })
  }
}
