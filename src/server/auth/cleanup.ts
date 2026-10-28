import type { Database } from "../database/connection"
/** Fixed cutoff and bounded transactions; refreshes cannot be removed using stale observations. */
export async function cleanExpiredAuth(db: Database, now: () => number): Promise<{ sessions: number; limits: number; batches: number }> {
  const cutoff = now()
  const result = { sessions: 0, limits: 0, batches: 0 }
  for (let batch = 0; batch < 10; batch++) {
    const deleted = await db.transaction(async c => {
      const sessions = (await c.query("SELECT token_hash,expires_at FROM equilens_auth_sessions WHERE expires_at<=$1 ORDER BY token_hash LIMIT 100", [cutoff])).rows
      const limits = (await c.query("SELECT limit_key,window_start FROM equilens_auth_limits WHERE window_start<=$1 ORDER BY limit_key LIMIT 100", [cutoff - 900000])).rows
      let removedSessions = 0, removedLimits = 0
      for (const row of sessions) removedSessions += (await c.query("DELETE FROM equilens_auth_sessions WHERE token_hash=$1 AND expires_at=$2 AND expires_at<=$3", [String(row.token_hash), Number(row.expires_at), cutoff])).changes
      for (const row of limits) removedLimits += (await c.query("DELETE FROM equilens_auth_limits WHERE limit_key=$1 AND window_start=$2 AND window_start<=$3", [String(row.limit_key), Number(row.window_start), cutoff - 900000])).changes
      return { sessions: removedSessions, limits: removedLimits, empty: !sessions.length && !limits.length }
    })
    result.batches++
    result.sessions += deleted.sessions; result.limits += deleted.limits
    if (deleted.empty) break
  }
  return result
}
