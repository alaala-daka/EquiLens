import type { Database, Connection, Row } from "../database/connection"
import { BusinessError } from "../projects/errors"

export class ResultRepository {
  constructor(readonly database: Database) {}
  transaction<T>(work: (connection: Connection) => Promise<T>) { return this.database.transaction(work) }
  async version(connection: Connection, projectId: string, resultId: string, versionId?: string): Promise<Row> {
    const result = (await connection.query("SELECT * FROM equilens_results WHERE project_id=$1 AND id=$2", [projectId, resultId])).rows[0]
    if (!result) throw new BusinessError("NOT_FOUND", "找不到该成果。")
    const version = (await connection.query("SELECT * FROM equilens_result_versions WHERE project_id=$1 AND result_id=$2 AND id=$3", [projectId, resultId, versionId ?? String(result.current_version_id)])).rows[0]
    if (!version) throw new BusinessError("NOT_FOUND", "找不到该成果版本。")
    return { ...version, kind: result.kind, current_version_id: result.current_version_id }
  }
}
